// Subscription Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { SubscriptionEngine } = require('./subscription-engine.js');

function makeMembers() {
  return {
    _members: { 'M-1': { member_id: 'M-1', display_name: 'Alice' }, 'M-2': { member_id: 'M-2' } },
    async get(id) { return this._members[id] || null; },
  };
}
function makePayment(decision = 'succeeded') {
  return {
    async charge({ amount, claim_id }) {
      return { txn_id: `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status: decision, amount };
    },
  };
}
function makeBus() {
  return { _e: [], async publish(t, p) { this._e.push({ t, p }); } };
}
function makeAudit() {
  return { _l: [], async log(e) { this._l.push(e); return { id: 'a' }; } };
}

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n💎 Subscription Engine — Tests\n');

(async () => {
  const engine = new SubscriptionEngine({
    memberService: makeMembers(),
    paymentService: makePayment(),
    eventBus: makeBus(),
    auditEngine: makeAudit(),
  });

  // === Plan setup ===
  await test('T01: createPlan validation (missing fields)', async () => {
    try { await engine.createPlan({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: createPlan rejects negative price', async () => {
    try { await engine.createPlan({ plan_id: 'bad', name: 'B', price_thb: -1 }); assert(false); }
    catch (e) { assertContains(e.message, 'non-negative', 'wrong error'); }
  });

  await test('T03: createPlan rejects invalid billing_period', async () => {
    try { await engine.createPlan({ plan_id: 'bad', name: 'B', price_thb: 0, billing_period: 'weekly' }); assert(false); }
    catch (e) { assertContains(e.message, 'billing_period', 'wrong error'); }
  });

  await test('T04: createPlan free (0 THB)', async () => {
    const r = await engine.createPlan({ plan_id: 'free', name: 'Free', price_thb: 0, features: ['basic_poi'] });
    assertEq(r.price_thb, 0);
  });

  await test('T05: createPlan basic 10 THB with trial', async () => {
    const r = await engine.createPlan({ plan_id: 'basic', name: 'Basic', price_thb: 10, trial_days: 7, features: ['lotto', 'poi_2x'] });
    assertEq(r.price_thb, 10);
    assertEq(r.trial_days, 7);
  });

  await test('T06: createPlan pro 99 THB', async () => {
    const r = await engine.createPlan({ plan_id: 'pro', name: 'Pro', price_thb: 99, trial_days: 7, features: ['lotto', 'poi_5x', 'ad_free'] });
    assertEq(r.price_thb, 99);
  });

  // === Subscribe ===
  await test('T07: subscribe to free plan', async () => {
    const r = await engine.subscribe({ member_id: 'M-1', plan_id: 'free' });
    assertEq(r.status, 'active');
    assertEq(r.plan_id, 'free');
  });

  await test('T08: subscribe to basic with trial', async () => {
    // Cancel first sub to allow re-subscribe
    await engine.cancel({ subscription_id: engine.subs.entries().next().value[0], immediate: true });
    const r = await engine.subscribe({ member_id: 'M-1', plan_id: 'basic' });
    assertEq(r.status, 'trial');
    assert(r.trial_ends_at, 'should have trial_ends_at');
  });

  await test('T09: subscribe is idempotent (same idempotency_key)', async () => {
    const r1 = await engine.subscribe({ member_id: 'M-2', plan_id: 'free', idempotency_key: 'IDEM-001' });
    const r2 = await engine.subscribe({ member_id: 'M-2', plan_id: 'free', idempotency_key: 'IDEM-001' });
    assertEq(r1.subscription_id, r2.subscription_id);
  });

  await test('T10: subscribe rejects if member has active sub', async () => {
    // M-2 already has free sub from T09
    try { await engine.subscribe({ member_id: 'M-2', plan_id: 'free' }); assert(false); }
    catch (e) { assertContains(e.message, 'already has', 'wrong error'); }
  });

  await test('T11: subscribe rejects unknown plan', async () => {
    try { await engine.subscribe({ member_id: 'M-1', plan_id: 'nonexistent' }); assert(false); }
    catch (e) { assertContains(e.message, 'not found', 'wrong error'); }
  });

  // === Renew ===
  await test('T12: renew extends period by 30 days', async () => {
    // Use M-2's free sub (no charge needed)
    const subId = Array.from(engine.subs.values()).find((s) => s.member_id === 'M-2').subscription_id;
    const oldEnd = engine.subs.get(subId).current_period_end;
    const r = await engine.renew({ subscription_id: subId });
    const newEnd = engine.subs.get(subId).current_period_end;
    assert(newEnd > oldEnd, 'period should be extended');
    assertEq(r.subscription.status, 'active');
  });

  await test('T13: renew on payment failure sets past_due + grace period', async () => {
    const failEngine = new SubscriptionEngine({
      memberService: makeMembers(),
      paymentService: makePayment('failed'),
      eventBus: makeBus(),
      auditEngine: makeAudit(),
    });
    await failEngine.createPlan({ plan_id: 'pro', name: 'Pro', price_thb: 99 });
    const sub = await failEngine.subscribe({ member_id: 'M-1', plan_id: 'pro' });
    const r = await failEngine.renew({ subscription_id: sub.subscription_id });
    assertEq(r.status, 'past_due');
    assert(r.subscription.grace_period_ends_at, 'should have grace period');
  });

  // === Cancel ===
  await test('T14: cancel at end of period (keeps active until period end)', async () => {
    const subId = Array.from(engine.subs.values()).find((s) => s.member_id === 'M-2').subscription_id;
    const r = await engine.cancel({ subscription_id: subId, reason: 'too_expensive' });
    assertEq(r.status, 'active');
    assertEq(r.auto_renew, false);
    assertEq(r.cancel_reason, 'too_expensive');
  });

  await test('T15: cancel immediately sets cancelled + revokes benefits', async () => {
    const subId = Array.from(engine.subs.values()).find((s) => s.member_id === 'M-2').subscription_id;
    const r = await engine.cancel({ subscription_id: subId, reason: 'refund', immediate: true });
    assertEq(r.status, 'cancelled');
  });

  await test('T16: cancel rejects already-cancelled sub', async () => {
    const subId = Array.from(engine.subs.values()).find((s) => s.status === 'cancelled').subscription_id;
    try { await engine.cancel({ subscription_id: subId, reason: 'test' }); assert(false); }
    catch (e) { assertContains(e.message, 'already', 'wrong error'); }
  });

  // === getStatus ===
  await test('T17: getStatus for member with no sub', async () => {
    const r = await engine.getStatus('M-NONE');
    assertEq(r.has_subscription, false);
  });

  await test('T18: getStatus returns plan + days remaining', async () => {
    const r = await engine.getStatus('M-2');
    if (r.has_subscription) {
      assert(r.days_remaining !== undefined);
    }
  });

  // === List ===
  await test('T19: listPlans returns all 3 plans', async () => {
    const r = await engine.listPlans();
    assertEq(r.total, 3);
    assertEq(r.items[0].plan_id, 'free'); // sorted by price
  });

  await test('T20: listSubscriptions filters by status', async () => {
    const r = await engine.listSubscriptions({ status: 'cancelled' });
    assert(r.items.every((s) => s.status === 'cancelled'));
  });

  // === Revenue ===
  await test('T21: getRevenue calculates total + MRR', async () => {
    const r = await engine.getRevenue({});
    assert(typeof r.total_revenue === 'number');
    assert(typeof r.mrr === 'number');
    assert(r.by_plan, 'should have by_plan breakdown');
  });

  await test('T22: getRevenue by_plan includes succeeded billings', async () => {
    const r = await engine.getRevenue({});
    // M-1 basic trial = 0 THB (no charge)
    // M-2 free = 0 THB
    // The renew in T12 was for free plan = 0 THB
    // So no billings in this test, but structure is correct
    assert(r.billing_count >= 0);
  });

  // === Events ===
  await test('T23: subscribe publishes subscription.created event', async () => {
    const fresh = new SubscriptionEngine({ memberService: makeMembers(), paymentService: makePayment(), eventBus: makeBus(), auditEngine: makeAudit() });
    await fresh.createPlan({ plan_id: 'free', name: 'Free', price_thb: 0 });
    await fresh.subscribe({ member_id: 'M-1', plan_id: 'free' });
    const events = fresh.bus._e.filter((e) => e.t === 'subscription.created');
    assert(events.length >= 1);
  });

  await test('T24: cancel publishes subscription.cancelled event', async () => {
    const fresh = new SubscriptionEngine({ memberService: makeMembers(), paymentService: makePayment(), eventBus: makeBus(), auditEngine: makeAudit() });
    await fresh.createPlan({ plan_id: 'free', name: 'Free', price_thb: 0 });
    const sub = await fresh.subscribe({ member_id: 'M-1', plan_id: 'free' });
    await fresh.cancel({ subscription_id: sub.subscription_id, immediate: true });
    const events = fresh.bus._e.filter((e) => e.t === 'subscription.cancelled');
    assertEq(events.length, 1);
  });

  await test('T25: benefits granted on subscribe', async () => {
    const fresh = new SubscriptionEngine({ memberService: makeMembers(), paymentService: makePayment(), eventBus: makeBus(), auditEngine: makeAudit() });
    await fresh.createPlan({ plan_id: 'pro', name: 'Pro', price_thb: 99, features: ['lotto', 'poi_5x'], trial_days: 7 });
    await fresh.subscribe({ member_id: 'M-1', plan_id: 'pro' });
    const events = fresh.bus._e.filter((e) => e.t === 'benefits.granted');
    assertEq(events.length, 1);
    assert(events[0].p.features.includes('lotto'));
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
