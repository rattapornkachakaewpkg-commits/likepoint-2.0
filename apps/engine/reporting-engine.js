// Reporting & Analytics Engine — PF-17 (Phase E)
// Aggregates metrics from audit_log (PF-5) + all engines
// Powers admin dashboard + B2B merchant analytics
// Author: AliClaw | Date: 2026-07-07

class ReportingEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.auditStore - PF-5 audit log
   * @param {Object} deps.subscriptionStore - PF-9
   * @param {Object} deps.merchantStore - PF-6
   * @param {Object} deps.memberStore
   * @param {Object} deps.notifStore - PF-15
   * @param {Object} deps.kycStore - PF-16
   * @param {Object} deps.kycApplicationStore - PF-16
   * @param {Object} deps.fxRateStore - PF-8
   * @param {Object} deps.giftCardStore - PF-11
   * @param {Object} deps.voucherStore - PF-12
   * @param {Object} deps.lottoStore - PF-10
   * @param {Object} deps.poiRuleStore - PF-7
   */
  constructor(deps = {}) {
    this.audit = deps.auditStore || new Map();
    this.subs = deps.subscriptionStore || new Map();
    this.merchants = deps.merchantStore || new Map();
    this.members = deps.memberStore || new Map();
    this.notifs = deps.notifStore || new Map();
    this.kycReviewers = deps.kycStore || new Map();
    this.kycApps = deps.kycApplicationStore || new Map();
    this.fxRates = deps.fxRateStore || new Map();
    this.giftCards = deps.giftCardStore || new Map();
    this.vouchers = deps.voucherStore || new Map();
    this.lotto = deps.lottoStore || new Map();
    this.poiRules = deps.poiRuleStore || new Map();
  }

  // ============================================================
  // 1. getOverview() — top-line KPIs
  // ============================================================
  async getOverview({ since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const subs = Array.from(this.subs.values()).filter(
      (s) => ['active', 'trial'].includes(s.status)
    );
    const merchants = Array.from(this.merchants.values()).filter((m) => m.status === 'active');
    const members = Array.from(this.members.values());
    const totalMr = subs.reduce((sum, s) => {
      const monthly = s.billing_period === 'yearly' ? s.price_thb / 12 : s.price_thb;
      return sum + monthly;
    }, 0);

    // Recent activity from audit log
    const events = Array.from(this.audit.values()).filter(
      (e) => new Date(e.created_at || e.ts).getTime() >= sinceMs
    );

    return {
      mrr: totalMr,
      arr: totalMr * 12,
      active_subscriptions: subs.length,
      active_merchants: merchants.length,
      total_members: members.length,
      total_events: events.length,
      events_per_day: events.length > 0 ? Math.round(events.length / Math.max(1, this._daysSince(sinceMs))) : 0,
    };
  }

  // ============================================================
  // 2. getMRR() — by plan + trend
  // ============================================================
  async getMRR({ since } = {}) {
    const subs = Array.from(this.subs.values()).filter(
      (s) => ['active', 'trial'].includes(s.status)
    );
    const byPlan = {};
    for (const s of subs) {
      const monthly = s.billing_period === 'yearly' ? s.price_thb / 12 : s.price_thb;
      if (!byPlan[s.plan_id]) {
        byPlan[s.plan_id] = { plan_id: s.plan_id, active_count: 0, mrr: 0 };
      }
      byPlan[s.plan_id].active_count++;
      byPlan[s.plan_id].mrr += monthly;
    }
    const totalMrr = Object.values(byPlan).reduce((s, p) => s + p.mrr, 0);
    return {
      total_mrr: totalMrr,
      total_arr: totalMrr * 12,
      by_plan: Object.values(byPlan),
    };
  }

  // ============================================================
  // 3. getRetention() — D1/D7/D30
  // ============================================================
  async getRetention({ cohortDays = 7, since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    // Simplified: use audit log SUBSCRIPTION_CREATED as "join" event
    // and last_seen as proxy for "active"
    const joinEvents = Array.from(this.audit.values()).filter(
      (e) => e.event_type === 'SUBSCRIPTION_CREATED' && new Date(e.created_at || e.ts).getTime() >= sinceMs
    );
    const uniqueJoiners = new Set(joinEvents.map((e) => e.member_id));
    if (uniqueJoiners.size === 0) {
      return { d1: 0, d7: 0, d30: 0, cohort_size: 0 };
    }
    // For prototype: simulate retention by event presence
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let d1 = 0, d7 = 0, d30 = 0;
    for (const e of joinEvents) {
      const joinTime = new Date(e.created_at || e.ts).getTime();
      const memberEvents = Array.from(this.audit.values()).filter(
        (ev) => ev.member_id === e.member_id
      );
      if (memberEvents.some((ev) => new Date(ev.created_at || ev.ts).getTime() >= joinTime + 1 * dayMs)) d1++;
      if (memberEvents.some((ev) => new Date(ev.created_at || ev.ts).getTime() >= joinTime + 7 * dayMs)) d7++;
      if (memberEvents.some((ev) => new Date(ev.created_at || ev.ts).getTime() >= joinTime + 30 * dayMs)) d30++;
    }
    return {
      d1: Math.round((d1 / uniqueJoiners.size) * 100),
      d7: Math.round((d7 / uniqueJoiners.size) * 100),
      d30: Math.round((d30 / uniqueJoiners.size) * 100),
      cohort_size: uniqueJoiners.size,
    };
  }

  // ============================================================
  // 4. getConversionFunnel() — Free → Basic → Pro
  // ============================================================
  async getConversionFunnel({ since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const members = Array.from(this.members.values());
    const totalMembers = members.length;
    let freeCount = 0, basicCount = 0, proCount = 0;
    for (const m of members) {
      if (m.tier === 'free' || !m.tier) freeCount++;
      else if (m.tier === 'pro') proCount++;
      else if (m.tier === 'enterprise') proCount++;
      else if (m.tier === 'basic' || m.tier === 'gold' || m.tier === 'silver') basicCount++;
    }
    return {
      total_members: totalMembers,
      free: freeCount,
      basic: basicCount,
      pro: proCount,
      free_to_paid_rate: totalMembers > 0 ? (((basicCount + proCount) / totalMembers) * 100).toFixed(1) : 0,
      basic_to_pro_rate: basicCount > 0 ? ((proCount / basicCount) * 100).toFixed(1) : 0,
    };
  }

  // ============================================================
  // 5. getTopMerchants() — by volume / users
  // ============================================================
  async getTopMerchants({ metric = 'volume', limit = 10, since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const events = Array.from(this.audit.values()).filter(
      (e) => ['MERCHANT_ONBOARDED', 'TOKEN_MINTED', 'VOUCHER_REDEEMED', 'LOTTO_TICKET_PURCHASED', 'GIFT_CARD_REDEEMED'].includes(e.event_type)
        && new Date(e.created_at || e.ts).getTime() >= sinceMs
    );
    const merchantCounts = {};
    for (const e of events) {
      const mid = e.resource_id || e.metadata?.merchant_id;
      if (!mid) continue;
      if (!merchantCounts[mid]) merchantCounts[mid] = { merchant_id: mid, count: 0, volume: 0 };
      merchantCounts[mid].count++;
      if (e.metadata?.amount) merchantCounts[mid].volume += e.metadata.amount;
    }
    const sorted = Object.values(merchantCounts).sort((a, b) => {
      return metric === 'volume' ? b.volume - a.volume : b.count - a.count;
    });
    return { total: sorted.length, items: sorted.slice(0, limit) };
  }

  // ============================================================
  // 6. getFXVolume() — cross-border transactions
  // ============================================================
  async getFXVolume({ since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    // Use audit log to find FX_RATE_SET events (proxy for FX usage)
    const events = Array.from(this.audit.values()).filter(
      (e) => e.event_type === 'FX_RATE_SET' && new Date(e.created_at || e.ts).getTime() >= sinceMs
    );
    const byPair = {};
    for (const e of events) {
      const pair = `${e.metadata?.from_currency || '?'}-${e.metadata?.to_currency || '?'}`;
      if (!byPair[pair]) byPair[pair] = { pair, count: 0, avg_rate: 0 };
      byPair[pair].count++;
      byPair[pair].avg_rate = e.metadata?.rate || 0;
    }
    return {
      total_fx_events: events.length,
      by_pair: Object.values(byPair),
      active_pairs: Object.keys(byPair).length,
    };
  }

  // ============================================================
  // 7. getEngagement() — POI / Lotto / Gift Card / Voucher / Notification
  // ============================================================
  async getEngagement({ since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const events = Array.from(this.audit.values()).filter(
      (e) => new Date(e.created_at || e.ts).getTime() >= sinceMs
    );
    const counts = {
      poi_triggers: events.filter((e) => e.event_type === 'POI_TRIGGERED').length,
      gift_cards_issued: events.filter((e) => e.event_type === 'GIFT_CARD_CREATED').length,
      gift_cards_redeemed: events.filter((e) => e.event_type === 'GIFT_CARD_REDEEMED').length,
      vouchers_redeemed: events.filter((e) => e.event_type === 'VOUCHER_REDEEMED').length,
      lotto_tickets: events.filter((e) => e.event_type === 'LOTTO_TICKET_PURCHASED').length,
      lotto_draws: events.filter((e) => e.event_type === 'LOTTO_DRAWN').length,
      notifications_sent: events.filter((e) => e.event_type === 'NOTIFICATION_SENT').length,
    };
    return counts;
  }

  // ============================================================
  // 8. getKYCPipeline() — pending/approved/rejected
  // ============================================================
  async getKYCPipeline({ since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const apps = Array.from(this.kycApps.values()).filter(
      (a) => new Date(a.submitted_at).getTime() >= sinceMs
    );
    return {
      total: apps.length,
      pending: apps.filter((a) => a.status === 'pending' || a.status === 'in_review').length,
      approved: apps.filter((a) => a.status === 'approved').length,
      rejected: apps.filter((a) => a.status === 'rejected').length,
      more_info: apps.filter((a) => a.status === 'more_info_required').length,
      approval_rate: apps.length > 0 ? ((apps.filter((a) => a.status === 'approved').length / apps.length) * 100).toFixed(1) : 0,
      sla_breaches: apps.filter((a) => new Date(a.sla_deadline) < new Date() && ['pending', 'in_review'].includes(a.status)).length,
    };
  }

  // ============================================================
  // helpers
  // ============================================================
  _daysSince(sinceMs) {
    if (sinceMs === 0) return 30; // default 30 days
    return Math.max(1, (Date.now() - sinceMs) / (24 * 60 * 60 * 1000));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ReportingEngine };
}
if (typeof window !== 'undefined') {
  window.ReportingEngine = ReportingEngine;
}
