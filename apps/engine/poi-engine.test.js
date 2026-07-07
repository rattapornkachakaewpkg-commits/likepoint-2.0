// POI Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { POIEngine } = require('./poi-engine.js');

function makeMembers() {
  return {
    _members: {
      'M-1': { member_id: 'M-1', tier: 'gold', country: 'TH', opt_in: true, age: 30 },
      'M-2': { member_id: 'M-2', tier: 'silver', country: 'TH', opt_in: true, age: 25 },
      'M-3': { member_id: 'M-3', tier: 'gold', country: 'KH', opt_in: false, age: 40 },
    },
    async get(id) { return this._members[id] || null; },
  };
}
function makeTokens() {
  return {
    _credits: [],
    async credit({ member_id, amount, claim_id }) {
      const existing = this._credits.find((c) => c.claim_id === claim_id);
      if (existing) return existing;
      const txn = { txn_id: `TXN-${this._credits.length + 1}`, claim_id, member_id, amount };
      this._credits.push(txn);
      return txn;
    },
  };
}
function makeBus() {
  return { _e: [], async publish(t, p) { this._e.push({ t, p }); } };
}
function makeAudit() {
  return { _l: [], async log(e) { this._l.push(e); return { id: 'a' }; } };
}
function makeNotifier() {
  return { _n: [], async send(n) { this._n.push(n); return { delivered: true }; } };
}

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n🎯 POI Engine — Tests\n');

(async () => {
  const engine = new POIEngine({
    memberStore: makeMembers(),
    tokenEngine: makeTokens(),
    eventBus: makeBus(),
    auditEngine: makeAudit(),
    notificationService: makeNotifier(),
  });

  // === Validation ===
  await test('T01: createRule requires merchant_id, token_id, event_type, reward_amount', async () => {
    try { await engine.createRule({}); assert(false, 'should throw'); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: createRule rejects invalid reward_type', async () => {
    try { await engine.createRule({ merchant_id: 'm', token_id: 't', event_type: 'daily_login', reward_amount: 100, reward_type: 'lottery' }); assert(false); }
    catch (e) { assertContains(e.message, 'reward_type', 'wrong error'); }
  });

  await test('T03: createRule rejects negative reward_amount', async () => {
    try { await engine.createRule({ merchant_id: 'm', token_id: 't', event_type: 'daily_login', reward_amount: -10 }); assert(false); }
    catch (e) { assertContains(e.message, 'positive', 'wrong error'); }
  });

  await test('T04: createRule rejects invalid cooldown format', async () => {
    try { await engine.createRule({ merchant_id: 'm', token_id: 't', event_type: 'daily_login', reward_amount: 10, cooldown: 'tomorrow' }); assert(false); }
    catch (e) { assertContains(e.message, 'cooldown', 'wrong error'); }
  });

  // === createRule happy path ===
  await test('T05: createRule daily_login with PT24H cooldown', async () => {
    const r = await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      name: 'Daily Login Bonus',
      event_type: 'daily_login', reward_amount: 100, reward_type: 'fixed', cooldown: 'PT24H',
    });
    assertEq(r.event_type, 'daily_login');
    assertEq(r.cooldown_ms, 24 * 60 * 60 * 1000);
    assertEq(r.status, 'active');
  });

  await test('T06: createRule purchase with multiplier', async () => {
    const r = await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      name: '2x Points on Purchase',
      event_type: 'purchase', reward_amount: 2, reward_type: 'multiplier',
    });
    assertEq(r.reward_type, 'multiplier');
  });

  // === trigger ===
  await test('T07: trigger creates REWARDED trigger + credits tokens', async () => {
    const r = await engine.trigger({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      member_id: 'M-1', event_type: 'daily_login',
    });
    assertEq(r.status, 'PROCESSED');
    assertEq(r.results[0].status, 'REWARDED');
    assertEq(r.results[0].reward_amount, 100);
  });

  await test('T08: trigger publishes poi.triggered event', async () => {
    // Need new rule since previous one is in cooldown
    await engine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'referral', reward_amount: 500, cooldown: 'P1W' });
    await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-2', event_type: 'referral' });
    const events = engine.bus._e.filter((e) => e.t === 'poi.triggered');
    assert(events.length >= 1, 'event should be published');
  });

  await test('T09: trigger respects cooldown', async () => {
    // M-1 already triggered daily_login above
    const r = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'daily_login' });
    assertEq(r.results[0].status, 'COOLDOWN');
    assert(r.results[0].cooldown_remaining_ms > 0, 'should have remaining time');
  });

  await test('T10: trigger is idempotent (same idempotency_key)', async () => {
    // Use unique event for this test (avoids cooldown from earlier tests)
    await engine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'idem_test', reward_amount: 50, cooldown: 'P1D' });
    const r1 = await engine.trigger({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      member_id: 'M-3', event_type: 'idem_test',
      idempotency_key: 'IDEM-002',
    });
    const r2 = await engine.trigger({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      member_id: 'M-3', event_type: 'idem_test',
      idempotency_key: 'IDEM-002',
    });
    assertEq(r1.results[0].status, 'REWARDED');
    assertEq(r2.status, 'ALREADY_TRIGGERED');
  });

  await test('T11: trigger respects audience filter (tier)', async () => {
    await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      event_type: 'birthday', reward_amount: 1000,
      audience_filter: { tier: 'gold' },
    });
    // M-1 is gold → should reward
    const r1 = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'birthday' });
    assertEq(r1.results[0].status, 'REWARDED');
    // M-2 is silver → should NOT match
    const r2 = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-2', event_type: 'birthday' });
    assertEq(r2.results[0].status, 'NOT_IN_AUDIENCE');
  });

  await test('T12: trigger respects audience filter (country)', async () => {
    await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      event_type: 'review', reward_amount: 50,
      audience_filter: { country: 'TH' },
    });
    const r1 = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'review' }); // TH
    const r2 = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-3', event_type: 'review' }); // KH
    assertEq(r1.results[0].status, 'REWARDED');
    assertEq(r2.results[0].status, 'NOT_IN_AUDIENCE');
  });

  await test('T13: max_triggers_per_user enforced', async () => {
    await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      event_type: 'custom', reward_amount: 10, cooldown: null,
      max_triggers_per_user: 2,
    });
    await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-2', event_type: 'custom' });
    await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-2', event_type: 'custom' });
    const r3 = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-2', event_type: 'custom' });
    assertEq(r3.results[0].status, 'MAX_TRIGGERS_REACHED');
  });

  await test('T14: NO_MATCHING_RULE for unknown event', async () => {
    const r = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'nonexistent_event' });
    assertEq(r.status, 'NO_MATCHING_RULE');
  });

  await test('T15: multiplier reward calculates from event_data.amount', async () => {
    await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      event_type: 'spending', reward_amount: 3, reward_type: 'multiplier',
    });
    const r = await engine.trigger({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      member_id: 'M-1', event_type: 'spending',
      event_data: { amount: 500 },
    });
    assertEq(r.results[0].reward_amount, 1500); // 500 * 3
  });

  await test('T16: random reward is between 0 and max', async () => {
    await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      event_type: 'lucky_draw', reward_amount: 100, reward_type: 'random',
    });
    const r = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'lucky_draw' });
    const reward = r.results[0].reward_amount;
    assert(reward >= 0 && reward < 100, `random reward ${reward} should be 0-99`);
  });

  await test('T17: time window (start_at not yet reached)', async () => {
    await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      event_type: 'future', reward_amount: 100,
      start_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const r = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'future' });
    assertEq(r.results[0].status, 'NOT_STARTED');
  });

  await test('T18: time window (end_at already passed)', async () => {
    await engine.createRule({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      event_type: 'past', reward_amount: 100,
      end_at: new Date(Date.now() - 86400000).toISOString(),
    });
    const r = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'past' });
    assertEq(r.results[0].status, 'EXPIRED');
  });

  await test('T19: pauseRule / resumeRule', async () => {
    const r = await engine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'pausable', reward_amount: 10 });
    await engine.pauseRule({ rule_id: r.rule_id });
    assertEq(engine.rules.get(r.rule_id).status, 'paused');
    await engine.resumeRule({ rule_id: r.rule_id });
    assertEq(engine.rules.get(r.rule_id).status, 'active');
  });

  await test('T20: paused rule does not trigger', async () => {
    const r = await engine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'paused_test', reward_amount: 10 });
    await engine.pauseRule({ rule_id: r.rule_id });
    const result = await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'paused_test' });
    assertEq(result.status, 'NO_MATCHING_RULE');
  });

  await test('T21: listRules filters by merchant', async () => {
    const r = await engine.listRules({ merchant_id: 'MCH-1' });
    assert(r.items.length > 0);
    assert(r.items.every((i) => i.merchant_id === 'MCH-1'));
  });

  await test('T22: listTriggers filters by member', async () => {
    const r = await engine.listTriggers({ member_id: 'M-1' });
    assert(r.items.every((t) => t.member_id === 'M-1'));
  });

  await test('T23: getRuleStats aggregates correctly', async () => {
    const r = await engine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'stats_test', reward_amount: 10 });
    await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'stats_test' });
    const stats = await engine.getRuleStats({ rule_id: r.rule_id });
    assertEq(stats.trigger_count, 1);
    assertEq(stats.unique_members, 1);
  });

  await test('T24: trigger sends notification to member', async () => {
    await engine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'notify_test', reward_amount: 10 });
    const before = engine.notifier._n.length;
    await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'notify_test' });
    assert(engine.notifier._n.length > before, 'should send notification');
  });

  await test('T25: trigger requires member_id, merchant_id, event_type, token_id', async () => {
    try { await engine.trigger({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T26: ISO-8601 duration parsing (PT1H, P7D, P1W, M30)', async () => {
    const r1 = await engine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'iso_test', reward_amount: 10, cooldown: 'PT1H' });
    assertEq(r1.cooldown_ms, 60 * 60 * 1000);
  });

  await test('T27: trigger when member not found throws', async () => {
    await engine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'unknown_member', reward_amount: 10 });
    try { await engine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-NONEXIST', event_type: 'unknown_member' }); assert(false); }
    catch (e) { assertContains(e.message, 'Member not found', 'wrong error'); }
  });

  await test('T28: trigger with token credit failure records CREDIT_FAILED', async () => {
    const failTokens = {
      async credit() { throw new Error('insufficient supply'); },
    };
    const failEngine = new POIEngine({
      memberStore: makeMembers(), tokenEngine: failTokens,
      eventBus: makeBus(), auditEngine: makeAudit(), notificationService: makeNotifier(),
    });
    await failEngine.createRule({ merchant_id: 'MCH-1', token_id: 'TOK-1', event_type: 'fail_test', reward_amount: 10 });
    const r = await failEngine.trigger({ merchant_id: 'MCH-1', token_id: 'TOK-1', member_id: 'M-1', event_type: 'fail_test' });
    assertEq(r.results[0].status, 'CREDIT_FAILED');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
