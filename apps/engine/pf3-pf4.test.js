// Reward Engine + Event Bus — Unit Tests
// 100% coverage for PF-3 (Reward) + PF-4 (Event Bus)
// Author: AliClaw | Date: 2026-07-07

const { RewardEngine } = require('./reward-engine');
const { EventBusEngine } = require('./event-bus');

// =================== HELPERS ===================
function mockWallets() {
  const store = new Map();
  return {
    findById: async (id) => store.get(id) || null,
    incrementBalance: async (id, delta) => {
      const w = store.get(id);
      if (!w) return null;
      w.balance = (w.balance || 0) + delta;
      store.set(id, w);
      return w;
    },
    _seed: (id, data) => store.set(id, { ...data, wallet_id: id })
  };
}

function mockLedger() {
  const claims = new Map();
  const txns = [];
  return {
    findClaim: async (id) => claims.get(id) || null,
    markClaim: async (id, data) => {
      const existing = claims.get(id) || { claim_id: id };
      claims.set(id, { ...existing, ...data });
      return claims.get(id);
    },
    credit: async (tx) => {
      const txn = { txn_id: `TX-${Date.now()}-${Math.random()}`, ...tx };
      txns.push(txn);
      return txn;
    },
    _claims: claims,
    _txns: txns
  };
}

function mockAudit() {
  const logs = [];
  return {
    logs,
    record: async (e) => { logs.push(e); }
  };
}

function mockNotify() {
  const sent = [];
  return {
    sent,
    notify: async (n) => { sent.push(n); }
  };
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ❌ ${name}: ${e.message}`);
  }
}

// =================== REWARD ENGINE ===================
(async () => {
  console.log('\n========== REWARD ENGINE (PF-3) ==========');

  // =================== grant() ===================
  console.log('\n--- grant() ---');
  await test('grants reward successfully', async () => {
    const w = mockWallets(), l = mockLedger(), a = mockAudit(), n = mockNotify();
    w._seed('W1', { person_id: 'P1', balance: 100 });
    const eng = new RewardEngine({ wallets: w, ledger: l, audit: a, notify: n.notify });
    const r = await eng.grant({ claim_id: 'C1', wallet_id: 'W1', member_id: 'P1', amount: 50, reward_type: 'DAILY_CLAIM' });
    if (r.status !== 'GRANTED') throw new Error(`expected GRANTED, got ${r.status}`);
    if (!n.sent.find((s) => s.type === 'REWARD_GRANTED')) throw new Error('should notify');
  });

  await test('idempotent: same claim_id twice returns already_processed', async () => {
    const w = mockWallets(), l = mockLedger(), a = mockAudit();
    w._seed('W1', { person_id: 'P1', balance: 100 });
    const eng = new RewardEngine({ wallets: w, ledger: l, audit: a });
    const r1 = await eng.grant({ claim_id: 'C-IDEMP', wallet_id: 'W1', member_id: 'P1', amount: 50, reward_type: 'DAILY_CLAIM' });
    const r2 = await eng.grant({ claim_id: 'C-IDEMP', wallet_id: 'W1', member_id: 'P1', amount: 50, reward_type: 'DAILY_CLAIM' });
    if (r2.status !== 'GRANTED') throw new Error('expected GRANTED from previous');
    if (!r2.already_processed) throw new Error('should mark already_processed');
  });

  await test('rejects missing fields', async () => {
    const w = mockWallets(), l = mockLedger();
    const eng = new RewardEngine({ wallets: w, ledger: l });
    let threw = false;
    try { await eng.grant({ wallet_id: 'W1' }); } catch (e) { threw = true; }
    if (!threw) throw new Error('should throw');
  });

  await test('rejects negative amount', async () => {
    const w = mockWallets(), l = mockLedger();
    const eng = new RewardEngine({ wallets: w, ledger: l });
    let threw = false;
    try { await eng.grant({ claim_id: 'C', wallet_id: 'W', member_id: 'P', amount: -5, reward_type: 'DAILY_CLAIM' }); } catch (e) { threw = true; }
    if (!threw) throw new Error('should throw');
  });

  await test('rejects invalid reward_type', async () => {
    const w = mockWallets(), l = mockLedger();
    const eng = new RewardEngine({ wallets: w, ledger: l });
    let threw = false;
    try { await eng.grant({ claim_id: 'C', wallet_id: 'W', member_id: 'P', amount: 5, reward_type: 'INVALID' }); } catch (e) { threw = true; }
    if (!threw) throw new Error('should throw');
  });

  await test('fails when wallet not found', async () => {
    const w = mockWallets(), l = mockLedger(), a = mockAudit();
    const eng = new RewardEngine({ wallets: w, ledger: l, audit: a });
    const r = await eng.grant({ claim_id: 'C-NW', wallet_id: 'MISSING', member_id: 'P1', amount: 5, reward_type: 'DAILY_CLAIM' });
    if (r.status !== 'FAILED') throw new Error('expected FAILED');
  });

  await test('retries on transient failure then succeeds', async () => {
    const w = mockWallets(), l = mockLedger(), a = mockAudit();
    w._seed('W1', { person_id: 'P1', balance: 100 });
    let calls = 0;
    const origCredit = l.credit;
    l.credit = async (tx) => {
      calls++;
      if (calls < 2) throw new Error('TRANSIENT');
      return await origCredit(tx);
    };
    const eng = new RewardEngine({ wallets: w, ledger: l, audit: a, config: { max_retries: 3, backoff_ms: 1 } });
    const r = await eng.grant({ claim_id: 'C-RETRY', wallet_id: 'W1', member_id: 'P1', amount: 5, reward_type: 'DAILY_CLAIM' });
    if (r.status !== 'GRANTED') throw new Error('expected GRANTED after retry');
    if (r.attempts !== 2) throw new Error(`expected 2 attempts, got ${r.attempts}`);
  });

  await test('marks FAILED after max retries', async () => {
    const w = mockWallets(), l = mockLedger(), a = mockAudit();
    w._seed('W1', { person_id: 'P1', balance: 100 });
    l.credit = async () => { throw new Error('ALWAYS_FAIL'); };
    const eng = new RewardEngine({ wallets: w, ledger: l, audit: a, config: { max_retries: 2, backoff_ms: 1 } });
    const r = await eng.grant({ claim_id: 'C-FAIL', wallet_id: 'W1', member_id: 'P1', amount: 5, reward_type: 'DAILY_CLAIM' });
    if (r.status !== 'FAILED') throw new Error('expected FAILED');
    if (r.attempts !== 2) throw new Error('expected 2 attempts');
  });

  // =================== processDailyClaim ===================
  console.log('\n--- processDailyClaim() ---');
  await test('uses today as default date', async () => {
    const w = mockWallets(), l = mockLedger(), a = mockAudit();
    w._seed('W1', { person_id: 'P1', balance: 0 });
    const eng = new RewardEngine({ wallets: w, ledger: l, audit: a });
    const r = await eng.processDailyClaim({ member_id: 'P1', wallet_id: 'W1' });
    if (r.status !== 'GRANTED') throw new Error('expected GRANTED');
    const today = new Date().toISOString().slice(0, 10);
    if (!r.claim_id.startsWith(`daily-${today}-`)) throw new Error('claim_id should have today');
  });

  // =================== processLockToWin ===================
  console.log('\n--- processLockToWin() ---');
  await test('records NO_WIN for amount=0', async () => {
    const w = mockWallets(), l = mockLedger();
    const eng = new RewardEngine({ wallets: w, ledger: l });
    const r = await eng.processLockToWin({ member_id: 'P1', wallet_id: 'W1', amount: 0, game_id: 'G1' });
    if (r.status !== 'NO_WIN') throw new Error('expected NO_WIN');
  });

  await test('grants reward for winning amount', async () => {
    const w = mockWallets(), l = mockLedger();
    w._seed('W1', { person_id: 'P1', balance: 0 });
    const eng = new RewardEngine({ wallets: w, ledger: l });
    const r = await eng.processLockToWin({ member_id: 'P1', wallet_id: 'W1', amount: 100, game_id: 'G2' });
    if (r.status !== 'GRANTED') throw new Error('expected GRANTED');
  });

  // =================== replayFailed ===================
  console.log('\n--- replayFailed() ---');
  await test('replays failed claim and resets to GRANTED', async () => {
    const w = mockWallets(), l = mockLedger(), a = mockAudit();
    w._seed('W1', { person_id: 'P1', balance: 0 });
    l._claims.set('C-FAIL-REPLAY', {
      claim_id: 'C-FAIL-REPLAY', wallet_id: 'W1', member_id: 'P1',
      amount: 10, reward_type: 'DAILY_CLAIM', status: 'FAILED'
    });
    const eng = new RewardEngine({ wallets: w, ledger: l, audit: a, config: { max_retries: 1, backoff_ms: 1 } });
    const r = await eng.replayFailed('C-FAIL-REPLAY');
    if (r.status !== 'GRANTED') throw new Error(`expected GRANTED, got ${r.status}`);
  });

  await test('rejects replay of non-FAILED claim', async () => {
    const w = mockWallets(), l = mockLedger();
    l._claims.set('C-OK', { status: 'GRANTED' });
    const eng = new RewardEngine({ wallets: w, ledger: l });
    let threw = false;
    try { await eng.replayFailed('C-OK'); } catch (e) { threw = true; }
    if (!threw) throw new Error('should throw');
  });

  // =================== runDailyBatch ===================
  console.log('\n--- runDailyBatch() ---');
  await test('processes all members and reports counts', async () => {
    const w = mockWallets(), l = mockLedger(), a = mockAudit();
    w._seed('W1', { person_id: 'P1', balance: 0 });
    w._seed('W2', { person_id: 'P2', balance: 0 });
    const eng = new RewardEngine({ wallets: w, ledger: l, audit: a, config: { max_retries: 1, backoff_ms: 1 } });
    const r = await eng.runDailyBatch([
      { member_id: 'P1', wallet_id: 'W1' },
      { member_id: 'P2', wallet_id: 'W2' }
    ]);
    if (r.total !== 2) throw new Error('expected 2');
    if (r.granted !== 2) throw new Error(`expected 2 granted, got ${r.granted}`);
  });

  // =================== EVENT BUS ENGINE ===================
  console.log('\n========== EVENT BUS ENGINE (PF-4) ==========');

  console.log('\n--- publish() ---');
  await test('publishes to subscriber and returns delivery count', async () => {
    const a = mockAudit();
    const bus = new EventBusEngine({ audit: a });
    let received = null;
    bus.subscribe('test.event', async (e) => { received = e; });
    const r = await bus.publish('test.event', { foo: 'bar' });
    if (r.delivered !== 1) throw new Error('expected 1 delivered');
    if (!received) throw new Error('should have received');
  });

  await test('routes failed handler to DLQ', async () => {
    const a = mockAudit();
    const bus = new EventBusEngine({ audit: a, config: { max_retries: 1, backoff_ms: 1 } });
    bus.subscribe('bad.event', async () => { throw new Error('Handler always fails'); });
    const r = await bus.publish('bad.event', { x: 1 });
    if (r.delivered !== 0) throw new Error('expected 0 delivered');
    if (r.dlq !== 1) throw new Error('expected 1 in DLQ');
    const dlq = await bus.getDLQ();
    if (dlq.length !== 1) throw new Error('DLQ should have 1 event');
  });

  await test('multiple subscribers all receive', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    const calls = [];
    bus.subscribe('multi', async () => { calls.push('A'); });
    bus.subscribe('multi', async () => { calls.push('B'); });
    const r = await bus.publish('multi', {});
    if (r.delivered !== 2) throw new Error('expected 2 delivered');
    if (calls.length !== 2) throw new Error('expected 2 calls');
  });

  await test('unsubscribe removes handler', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let count = 0;
    const handler = async () => { count++; };
    const unsub = bus.subscribe('unsub.test', handler);
    unsub();
    await bus.publish('unsub.test', {});
    if (count !== 0) throw new Error('handler should not fire');
  });

  await test('rejects missing topic/payload', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let threw = false;
    try { await bus.publish('', {}); } catch (e) { threw = true; }
    if (!threw) throw new Error('should throw');
  });

  await test('subscribers are isolated by topic', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let t1 = 0, t2 = 0;
    bus.subscribe('topic1', async () => { t1++; });
    bus.subscribe('topic2', async () => { t2++; });
    await bus.publish('topic1', {});
    if (t1 !== 1 || t2 !== 0) throw new Error('cross-talk');
  });

  // =================== DLQ ===================
  console.log('\n--- DLQ replay() ---');
  await test('replays DLQ event successfully and removes it', async () => {
    const bus = new EventBusEngine({ audit: mockAudit(), config: { max_retries: 1, backoff_ms: 1 } });
    bus.subscribe('dlq.test', async () => { throw new Error('fail'); });
    await bus.publish('dlq.test', { x: 1 });
    const dlq = await bus.getDLQ();
    if (dlq.length !== 1) throw new Error('DLQ should have 1');
    const result = await bus.replayDLQ(dlq[0].event_id, async () => { /* success */ });
    if (!result.replayed) throw new Error('should replay');
    const after = await bus.getDLQ();
    if (after.length !== 0) throw new Error('DLQ should be empty after replay');
  });

  await test('replayDLQ throws on missing event', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let threw = false;
    try { await bus.replayDLQ('nonexistent', async () => {}); } catch (e) { threw = true; }
    if (!threw) throw new Error('should throw');
  });

  // =================== Domain helpers ===================
  console.log('\n--- Domain helpers ---');
  await test('publishPhoneChanged emits phone.changed', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let got = null;
    bus.subscribe('phone.changed', async (e) => { got = e; });
    await bus.publishPhoneChanged({ person_id: 'P1', old_phone_hash: 'OLD', new_phone_hash: 'NEW' });
    if (!got) throw new Error('should receive');
    if (got.payload.person_id !== 'P1') throw new Error('wrong payload');
  });

  await test('publishPointCredited emits point.credited', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let got = null;
    bus.subscribe('point.credited', async (e) => { got = e; });
    await bus.publishPointCredited({ wallet_id: 'W1', member_id: 'P1', amount: 100, source: 'bct', ref_id: 'R1' });
    if (got.payload.amount !== 100) throw new Error('wrong amount');
  });

  await test('publishCrossTenantTransfer emits point.transferred', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let got = null;
    bus.subscribe('point.transferred', async (e) => { got = e; });
    await bus.publishCrossTenantTransfer({ member_id: 'P1', from_tenant: 'AAM', to_tenant: 'LP2', amount: 50, txn_id: 'T1' });
    if (got.payload.from_tenant !== 'AAM') throw new Error('wrong from');
  });

  await test('publishWalletRebound emits wallet.rebound', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let got = null;
    bus.subscribe('wallet.rebound', async (e) => { got = e; });
    await bus.publishWalletRebound({ person_id: 'P1', wallet_id: 'W1', old_phone_hash: 'O', new_phone_hash: 'N' });
    if (!got) throw new Error('should receive');
  });

  await test('publishRewardGranted emits reward.granted', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let got = null;
    bus.subscribe('reward.granted', async (e) => { got = e; });
    await bus.publishRewardGranted({ member_id: 'P1', wallet_id: 'W1', amount: 10, reward_type: 'DAILY_CLAIM', claim_id: 'C1' });
    if (got.payload.reward_type !== 'DAILY_CLAIM') throw new Error('wrong type');
  });

  await test('publishAAMMigrated emits aam.migrated', async () => {
    const bus = new EventBusEngine({ audit: mockAudit() });
    let got = null;
    bus.subscribe('aam.migrated', async (e) => { got = e; });
    await bus.publishAAMMigrated({ member_id: 'P1', aam_ledger_balance: 1500 });
    if (got.payload.aam_ledger_balance !== 1500) throw new Error('wrong balance');
  });

  // =================== Summary ===================
  console.log(`\n========================================`);
  console.log(`Results: ${pass} pass, ${fail} fail`);
  console.log(`========================================`);
  process.exit(fail > 0 ? 1 : 0);
})();
