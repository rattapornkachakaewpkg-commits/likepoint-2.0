// Reporting Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { ReportingEngine } = require('./reporting-engine.js');

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n📊 Reporting Engine — Tests\n');

// Sample data
const subs = new Map();
subs.set('SUB-1', { plan_id: 'basic', status: 'active', price_thb: 10, billing_period: 'monthly' });
subs.set('SUB-2', { plan_id: 'pro', status: 'active', price_thb: 99, billing_period: 'monthly' });
subs.set('SUB-3', { plan_id: 'basic', status: 'trial', price_thb: 10, billing_period: 'monthly' });
subs.set('SUB-4', { plan_id: 'pro', status: 'active', price_thb: 1188, billing_period: 'yearly' }); // 99/mo

const members = new Map();
members.set('M-1', { member_id: 'M-1', tier: 'free' });
members.set('M-2', { member_id: 'M-2', tier: 'pro' });
members.set('M-3', { member_id: 'M-3', tier: 'free' });
members.set('M-4', { member_id: 'M-4', tier: 'enterprise' });

const merchants = new Map();
merchants.set('MCH-1', { merchant_id: 'MCH-1', status: 'active' });
merchants.set('MCH-2', { merchant_id: 'MCH-2', status: 'active' });

const audit = new Map();
const now = new Date().toISOString();
audit.set('A-1', { event_type: 'POI_TRIGGERED', member_id: 'M-1', created_at: now });
audit.set('A-2', { event_type: 'GIFT_CARD_REDEEMED', member_id: 'M-2', created_at: now });
audit.set('A-3', { event_type: 'SUBSCRIPTION_CREATED', member_id: 'M-1', created_at: now });
audit.set('A-4', { event_type: 'LOTTO_DRAWN', member_id: 'M-3', created_at: now });
audit.set('A-5', { event_type: 'FX_RATE_SET', resource_id: 'FXR-1', metadata: { from_currency: 'USD', to_currency: 'THB', rate: 37 }, created_at: now });
audit.set('A-6', { event_type: 'VOUCHER_REDEEMED', member_id: 'M-1', created_at: now });
audit.set('A-7', { event_type: 'NOTIFICATION_SENT', member_id: 'M-2', created_at: now });

const kycApps = new Map();
kycApps.set('KYC-1', { application_id: 'KYC-1', member_id: 'M-2', status: 'approved', submitted_at: now, sla_deadline: new Date(Date.now() + 86400000).toISOString() });
kycApps.set('KYC-2', { application_id: 'KYC-2', member_id: 'M-4', status: 'in_review', submitted_at: now, sla_deadline: new Date(Date.now() + 86400000).toISOString() });
kycApps.set('KYC-3', { application_id: 'KYC-3', member_id: 'M-5', status: 'rejected', submitted_at: now, sla_deadline: new Date(Date.now() + 86400000).toISOString() });

const engine = new ReportingEngine({
  auditStore: audit,
  subscriptionStore: subs,
  memberStore: members,
  merchantStore: merchants,
  kycApplicationStore: kycApps,
});

(async () => {
  // === getOverview ===
  await test('T01: getOverview returns MRR (basic + pro monthly + pro yearly/12)', async () => {
    const r = await engine.getOverview({});
    // 10 (basic active) + 99 (pro active) + 10 (basic trial) + 1188/12=99 (pro yearly active) = 218
    assertEq(r.mrr, 218);
    assertEq(r.arr, 218 * 12);
  });

  await test('T02: getOverview counts active subs, merchants, members', async () => {
    const r = await engine.getOverview({});
    assertEq(r.active_subscriptions, 4);
    assertEq(r.active_merchants, 2);
    assertEq(r.total_members, 4);
  });

  await test('T03: getOverview counts recent events', async () => {
    const r = await engine.getOverview({});
    assert(r.total_events > 0);
  });

  // === getMRR ===
  await test('T04: getMRR breaks down by plan', async () => {
    const r = await engine.getMRR({});
    const basic = r.by_plan.find((p) => p.plan_id === 'basic');
    const pro = r.by_plan.find((p) => p.plan_id === 'pro');
    assert(basic.active_count === 2); // 1 active + 1 trial
    assert(pro.active_count === 2);
  });

  // === getConversionFunnel ===
  await test('T05: getConversionFunnel counts by tier', async () => {
    const r = await engine.getConversionFunnel({});
    assertEq(r.total_members, 4);
    assertEq(r.free, 2);
    assertEq(r.pro, 2); // pro + enterprise
  });

  await test('T06: getConversionFunnel calculates free-to-paid rate', async () => {
    const r = await engine.getConversionFunnel({});
    assertEq(r.free_to_paid_rate, '50.0'); // 2/4 = 50%
  });

  // === getTopMerchants ===
  await test('T07: getTopMerchants returns top N by metric', async () => {
    // Add some merchant events
    audit.set('M-1', { event_type: 'TOKEN_MINTED', member_id: 'M-1', resource_id: 'MCH-1', created_at: now });
    audit.set('M-2', { event_type: 'TOKEN_MINTED', member_id: 'M-1', resource_id: 'MCH-1', created_at: now });
    audit.set('M-3', { event_type: 'VOUCHER_REDEEMED', member_id: 'M-1', resource_id: 'MCH-2', created_at: now });
    const r = await engine.getTopMerchants({ metric: 'count', limit: 5 });
    assert(r.items.length > 0);
  });

  // === getFXVolume ===
  await test('T08: getFXVolume aggregates by pair', async () => {
    const r = await engine.getFXVolume({});
    assert(r.total_fx_events >= 1);
    assert(r.by_pair.length > 0);
    assert(r.by_pair[0].pair === 'USD-THB');
  });

  // === getEngagement ===
  await test('T09: getEngagement counts each event type', async () => {
    // Use fresh engine with isolated audit log
    const isolatedAudit = new Map();
    isolatedAudit.set('A-1', { event_type: 'POI_TRIGGERED', member_id: 'M-1', created_at: now });
    isolatedAudit.set('A-2', { event_type: 'GIFT_CARD_REDEEMED', member_id: 'M-2', created_at: now });
    isolatedAudit.set('A-3', { event_type: 'LOTTO_DRAWN', member_id: 'M-3', created_at: now });
    isolatedAudit.set('A-4', { event_type: 'VOUCHER_REDEEMED', member_id: 'M-1', created_at: now });
    isolatedAudit.set('A-5', { event_type: 'NOTIFICATION_SENT', member_id: 'M-2', created_at: now });
    const isolated = new ReportingEngine({ auditStore: isolatedAudit, subscriptionStore: new Map(), memberStore: new Map(), merchantStore: new Map() });
    const r = await isolated.getEngagement({});
    assertEq(r.poi_triggers, 1);
    assertEq(r.gift_cards_redeemed, 1);
    assertEq(r.vouchers_redeemed, 1);
    assertEq(r.lotto_draws, 1);
    assertEq(r.notifications_sent, 1);
  });

  // === getKYCPipeline ===
  await test('T10: getKYCPipeline counts by status', async () => {
    const r = await engine.getKYCPipeline({});
    assertEq(r.total, 3);
    assertEq(r.approved, 1);
    assertEq(r.pending, 1);
    assertEq(r.rejected, 1);
  });

  await test('T11: getKYCPipeline calculates approval rate', async () => {
    const r = await engine.getKYCPipeline({});
    assertEq(r.approval_rate, '33.3'); // 1/3 = 33.3%
  });

  // === getRetention ===
  await test('T12: getRetention returns D1/D7/D30 percentages', async () => {
    const r = await engine.getRetention({});
    assert(typeof r.d1 === 'number');
    assert(typeof r.d7 === 'number');
    assert(typeof r.d30 === 'number');
    assert(typeof r.cohort_size === 'number');
  });

  await test('T13: getRetention with empty cohort returns zeros', async () => {
    const emptyEngine = new ReportingEngine({ auditStore: new Map(), subscriptionStore: new Map(), memberStore: new Map(), merchantStore: new Map() });
    const r = await emptyEngine.getRetention({});
    assertEq(r.d1, 0);
    assertEq(r.cohort_size, 0);
  });

  // === getFXVolume (more) ===
  await test('T14: getFXVolume returns unique pairs count', async () => {
    const r = await engine.getFXVolume({});
    assertEq(r.active_pairs, 1);
  });

  // === with empty data ===
  await test('T15: all methods handle empty data gracefully', async () => {
    const e = new ReportingEngine();
    const o = await e.getOverview({});
    assertEq(o.mrr, 0);
    const m = await e.getMRR({});
    assertEq(m.total_mrr, 0);
    const f = await e.getConversionFunnel({});
    assertEq(f.total_members, 0);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
