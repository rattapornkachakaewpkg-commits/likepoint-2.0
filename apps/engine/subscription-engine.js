// Subscription Engine — PF-9 (Phase E)
// Recurring revenue stream: 3-tier plans (Free / Basic / Pro) with benefits
// Based on NB vision (25/06/2023): "User ซื้อ Subscription ได้ เพื่อทำกิจกรรม earn point, Lotto (ค่าเดือนละ 10 บาท)"
// Author: AliClaw | Date: 2026-07-07

class SubscriptionEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.planStore
   * @param {Object} deps.subscriptionStore
   * @param {Object} deps.billingStore
   * @param {Object} deps.memberService - get member profile + tier
   * @param {Object} deps.paymentService - charge member (mock for prototype)
   * @param {Object} deps.auditEngine - PF-5 integration
   * @param {Object} deps.eventBus - publish subscription events
   */
  constructor({ planStore, subscriptionStore, billingStore, memberService, paymentService, auditEngine, eventBus } = {}) {
    this.plans = planStore || new Map();
    this.subs = subscriptionStore || new Map();
    this.billings = billingStore || new Map();
    this.members = memberService || { get: async () => null, update: async () => null };
    this.payment = paymentService || { charge: async () => ({ txn_id: 'mock', status: 'succeeded' }) };
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this._idSeq = 0;
  }

  // ============================================================
  // 1. createPlan()
  // ============================================================
  async createPlan({ plan_id, name, price_thb, billing_period = 'monthly', features = [], badge = null, trial_days = 0, actor = 'admin' }) {
    if (!plan_id || !name || price_thb === undefined) {
      throw new Error('plan_id, name, price_thb are required');
    }
    if (typeof price_thb !== 'number' || price_thb < 0) {
      throw new Error('price_thb must be non-negative number');
    }
    if (!['monthly', 'yearly'].includes(billing_period)) {
      throw new Error(`Invalid billing_period: ${billing_period}`);
    }

    const plan = {
      plan_id,
      name,
      price_thb,
      billing_period,
      features,
      badge,
      trial_days,
      status: 'active',
      created_at: new Date().toISOString(),
    };
    this.plans.set(plan_id, plan);

    await this.audit.log({
      event_type: 'PLAN_CREATED', actor,
      resource_type: 'plan', resource_id: plan_id,
      action: 'CREATE',
      metadata: { name, price_thb, billing_period, trial_days },
    });
    return plan;
  }

  // ============================================================
  // 2. subscribe()
  // ============================================================
  async subscribe({ member_id, plan_id, payment_method = 'promptpay', idempotency_key = null, actor = 'system' }) {
    if (!member_id || !plan_id) throw new Error('member_id, plan_id are required');
    const plan = this.plans.get(plan_id);
    if (!plan) throw new Error(`Plan not found: ${plan_id}`);
    if (plan.status !== 'active') throw new Error(`Plan is ${plan.status}`);

    // Idempotency
    if (idempotency_key) {
      const existing = Array.from(this.subs.values()).find((s) => s.idempotency_key === idempotency_key);
      if (existing) return existing;
    }

    // Check existing active subscription
    const existingSub = Array.from(this.subs.values()).find(
      (s) => s.member_id === member_id && ['trial', 'active', 'past_due'].includes(s.status)
    );
    if (existingSub) {
      throw new Error(`Member already has active subscription: ${existingSub.subscription_id}`);
    }

    const member = await this.members.get(member_id);
    if (!member) throw new Error(`Member not found: ${member_id}`);

    // Trial logic
    const now = new Date();
    const isPaid = plan.price_thb > 0;
    const trial = isPaid && plan.trial_days > 0;
    const status = trial ? 'trial' : 'active';

    const subscription_id = `SUB-${Date.now()}-${++this._idSeq}`;
    const periodStart = now;
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + (trial ? plan.trial_days : 30));

    const sub = {
      subscription_id,
      member_id,
      plan_id,
      status,
      idempotency_key,
      started_at: now.toISOString(),
      current_period_start: periodStart.toISOString(),
      current_period_end: periodEnd.toISOString(),
      next_billing_at: trial ? periodEnd.toISOString() : periodEnd.toISOString(),
      trial_ends_at: trial ? periodEnd.toISOString() : null,
      grace_period_ends_at: null,
      cancelled_at: null,
      cancel_reason: null,
      auto_renew: true,
      payment_method,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.subs.set(subscription_id, sub);

    // Charge immediately if paid + no trial
    if (isPaid && !trial) {
      await this._chargeAndRecord(sub, plan);
    }

    // Grant benefits
    await this._grantBenefits({ member_id, plan, source: subscription_id });

    await this.bus.publish('subscription.created', { subscription_id, member_id, plan_id, status });
    await this.audit.log({
      event_type: 'SUBSCRIPTION_CREATED', actor,
      resource_type: 'subscription', resource_id: subscription_id,
      member_id, action: 'CREATE',
      metadata: { plan_id, status, is_trial: trial },
    });

    return sub;
  }

  // ============================================================
  // 3. renew() — billing cycle renewal
  // ============================================================
  async renew({ subscription_id, payment_ref = null, actor = 'system' }) {
    const sub = this.subs.get(subscription_id);
    if (!sub) throw new Error(`Subscription not found: ${subscription_id}`);
    if (sub.status !== 'active' && sub.status !== 'past_due') {
      throw new Error(`Cannot renew subscription in status: ${sub.status}`);
    }
    const plan = this.plans.get(sub.plan_id);
    if (!plan) throw new Error(`Plan not found: ${sub.plan_id}`);

    // Charge
    const payment = await this.payment.charge({
      member_id: sub.member_id, amount: plan.price_thb,
      payment_method: sub.payment_method, payment_ref,
      claim_id: `SUB-${subscription_id}-${Date.now()}`,
    });

    if (payment.status === 'failed') {
      return await this._handlePaymentFailed(sub, plan);
    }

    // Extend period
    const oldPeriodEnd = new Date(sub.current_period_end);
    const newPeriodEnd = new Date(oldPeriodEnd);
    newPeriodEnd.setDate(newPeriodEnd.getDate() + 30);

    sub.current_period_start = oldPeriodEnd.toISOString();
    sub.current_period_end = newPeriodEnd.toISOString();
    sub.next_billing_at = newPeriodEnd.toISOString();
    sub.status = 'active';
    sub.grace_period_ends_at = null;
    sub.updated_at = new Date().toISOString();

    const billing_id = `BIL-${Date.now()}-${++this._idSeq}`;
    this.billings.set(billing_id, {
      billing_id, subscription_id, member_id: sub.member_id,
      amount: plan.price_thb, payment_ref: payment.txn_id,
      status: 'succeeded',
      billing_period_start: sub.current_period_start,
      billing_period_end: sub.current_period_end,
      created_at: new Date().toISOString(),
    });

    await this.bus.publish('subscription.renewed', { subscription_id, billing_id, amount: plan.price_thb });
    await this.audit.log({
      event_type: 'SUBSCRIPTION_RENEWED', actor,
      resource_type: 'subscription', resource_id: subscription_id,
      member_id: sub.member_id, action: 'UPDATE',
      metadata: { billing_id, amount: plan.price_thb, new_period_end: newPeriodEnd.toISOString() },
    });
    return { subscription: sub, billing_id };
  }

  // ============================================================
  // 4. cancel()
  // ============================================================
  async cancel({ subscription_id, reason = 'user_request', immediate = false, actor = 'user' }) {
    const sub = this.subs.get(subscription_id);
    if (!sub) throw new Error(`Subscription not found: ${subscription_id}`);
    if (sub.status === 'cancelled' || sub.status === 'expired') {
      throw new Error(`Subscription already ${sub.status}`);
    }

    const now = new Date();
    sub.cancelled_at = now.toISOString();
    sub.cancel_reason = reason;
    sub.auto_renew = false;
    sub.updated_at = now.toISOString();

    if (immediate) {
      sub.status = 'cancelled';
      await this._revokeBenefits({ member_id: sub.member_id, plan_id: sub.plan_id });
    } else {
      // Cancel at end of period
      sub.status = 'active'; // stays active until period end, then expires
    }

    await this.bus.publish('subscription.cancelled', { subscription_id, reason, immediate });
    await this.audit.log({
      event_type: 'SUBSCRIPTION_CANCELLED', actor,
      resource_type: 'subscription', resource_id: subscription_id,
      member_id: sub.member_id, action: 'UPDATE',
      metadata: { reason, immediate, effective_at: sub.current_period_end },
    });
    return sub;
  }

  // ============================================================
  // 5. getStatus()
  // ============================================================
  async getStatus(member_id) {
    if (!member_id) throw new Error('member_id is required');
    const sub = Array.from(this.subs.values()).find(
      (s) => s.member_id === member_id && ['trial', 'active', 'past_due'].includes(s.status)
    );
    if (!sub) return { member_id, has_subscription: false };
    const plan = this.plans.get(sub.plan_id);
    const now = new Date();
    const periodEnd = new Date(sub.current_period_end);
    const daysRemaining = Math.max(0, Math.ceil((periodEnd - now) / (24 * 60 * 60 * 1000)));
    return {
      member_id,
      has_subscription: true,
      subscription_id: sub.subscription_id,
      plan_id: sub.plan_id,
      plan_name: plan?.name,
      status: sub.status,
      is_trial: sub.status === 'trial',
      trial_ends_at: sub.trial_ends_at,
      current_period_end: sub.current_period_end,
      days_remaining: daysRemaining,
      next_billing_at: sub.next_billing_at,
      auto_renew: sub.auto_renew,
      features: plan?.features || [],
    };
  }

  // ============================================================
  // 6. listPlans()
  // ============================================================
  async listPlans({ status = 'active', limit = 50 } = {}) {
    let all = Array.from(this.plans.values());
    if (status) all = all.filter((p) => p.status === status);
    all.sort((a, b) => a.price_thb - b.price_thb);
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 7. listSubscriptions()
  // ============================================================
  async listSubscriptions({ plan_id, status, since, limit = 100 } = {}) {
    let all = Array.from(this.subs.values());
    if (plan_id) all = all.filter((s) => s.plan_id === plan_id);
    if (status) all = all.filter((s) => s.status === status);
    if (since) {
      const sinceMs = new Date(since).getTime();
      all = all.filter((s) => new Date(s.created_at).getTime() >= sinceMs);
    }
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 8. getRevenue()
  // ============================================================
  async getRevenue({ since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const billings = Array.from(this.billings.values()).filter(
      (b) => b.status === 'succeeded' && new Date(b.created_at).getTime() >= sinceMs
    );
    const total = billings.reduce((s, b) => s + b.amount, 0);

    // MRR (Monthly Recurring Revenue)
    const activeSubs = Array.from(this.subs.values()).filter(
      (s) => s.status === 'active' || s.status === 'trial'
    );
    const mrr = activeSubs.reduce((sum, s) => {
      const plan = this.plans.get(s.plan_id);
      if (!plan) return sum;
      const monthlyAmount = plan.billing_period === 'yearly' ? plan.price_thb / 12 : plan.price_thb;
      return sum + monthlyAmount;
    }, 0);

    // By plan
    const byPlan = {};
    for (const b of billings) {
      const sub = this.subs.get(b.subscription_id);
      if (!sub) continue;
      if (!byPlan[sub.plan_id]) byPlan[sub.plan_id] = { count: 0, revenue: 0 };
      byPlan[sub.plan_id].count++;
      byPlan[sub.plan_id].revenue += b.amount;
    }

    return {
      since: since || 'all time',
      total_revenue: total,
      mrr,
      active_subscriptions: activeSubs.length,
      billing_count: billings.length,
      by_plan: byPlan,
    };
  }

  // ============================================================
  // private helpers
  // ============================================================
  async _chargeAndRecord(sub, plan) {
    const payment = await this.payment.charge({
      member_id: sub.member_id, amount: plan.price_thb,
      payment_method: sub.payment_method,
      claim_id: `SUB-INIT-${sub.subscription_id}`,
    });
    const billing_id = `BIL-${Date.now()}-${++this._idSeq}`;
    this.billings.set(billing_id, {
      billing_id, subscription_id: sub.subscription_id, member_id: sub.member_id,
      amount: plan.price_thb, payment_ref: payment.txn_id,
      status: payment.status,
      billing_period_start: sub.current_period_start,
      billing_period_end: sub.current_period_end,
      created_at: new Date().toISOString(),
    });
    if (payment.status === 'failed') {
      sub.status = 'past_due';
      sub.grace_period_ends_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  async _handlePaymentFailed(sub, plan) {
    sub.status = 'past_due';
    sub.grace_period_ends_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    sub.updated_at = new Date().toISOString();

    const billing_id = `BIL-${Date.now()}-${++this._idSeq}`;
    this.billings.set(billing_id, {
      billing_id, subscription_id: sub.subscription_id, member_id: sub.member_id,
      amount: plan.price_thb, payment_ref: null, status: 'failed',
      billing_period_start: sub.current_period_start,
      billing_period_end: sub.current_period_end,
      created_at: new Date().toISOString(),
    });

    await this.bus.publish('subscription.payment_failed', { subscription_id: sub.subscription_id });
    await this.audit.log({
      event_type: 'SUBSCRIPTION_PAYMENT_FAILED', actor: 'system',
      resource_type: 'subscription', resource_id: sub.subscription_id,
      member_id: sub.member_id, action: 'UPDATE',
      metadata: { grace_period_ends_at: sub.grace_period_ends_at },
    });
    return { subscription: sub, billing_id, status: 'past_due' };
  }

  async _grantBenefits({ member_id, plan, source }) {
    // Hook for benefit grants (Lotto tickets, premium POI access, ad-free)
    // In production: integrate with POI engine, lotto engine, ad server
    if (plan.features && plan.features.length > 0) {
      await this.bus.publish('benefits.granted', { member_id, plan_id: plan.plan_id, features: plan.features, source });
      await this.audit.log({
        event_type: 'BENEFITS_GRANTED', actor: 'system',
        resource_type: 'subscription', resource_id: source,
        member_id, action: 'CREATE',
        metadata: { plan_id: plan.plan_id, features: plan.features },
      });
    }
  }

  async _revokeBenefits({ member_id, plan_id }) {
    await this.bus.publish('benefits.revoked', { member_id, plan_id, reason: 'subscription_cancelled' });
    await this.audit.log({
      event_type: 'BENEFITS_REVOKED', actor: 'system',
      resource_type: 'subscription', resource_id: plan_id,
      member_id, action: 'DELETE',
      metadata: { reason: 'subscription_cancelled' },
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SubscriptionEngine };
}
if (typeof window !== 'undefined') {
  window.SubscriptionEngine = SubscriptionEngine;
}
