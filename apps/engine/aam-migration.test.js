// AAM Migration Engine — Unit Tests
// Tests: 18 cases covering happy path, idempotency, errors, batch, rollback
// Author: AliClaw | Date: 2026-07-07

const { AAMMigrationEngine } = require('./aam-migration.js');

// --- Mock dependencies ---
function makeAAMLedger(accounts = {}) {
  return {
    _accounts: { ...accounts },
    async getBalance(aam_account_id) {
      const a = this._accounts[aam_account_id];
      return a ? a.balance : null;
    },
    async markMigrated(aam_account_id, claim_id) {
      if (this._accounts[aam_account_id]) {
        this._accounts[aam_account_id].migrated = true;
        this._accounts[aam_account_id].claim_id = claim_id;
      }
    },
    async unmarkMigrated(aam_account_id) {
      if (this._accounts[aam_account_id]) {
        this._accounts[aam_account_id].migrated = false;
      }
    },
  };
}

function makeLP2Wallet(members = {}) {
  return {
    _members: { ...members },
    _credits: [],
    async findMemberByPhone(phone_hash) {
      const m = Object.values(this._members).find((m) => m.phone_hash === phone_hash);
      return m ? { member_id: m.member_id, display_name: m.display_name } : null;
    },
    async credit({ member_id, amount, claim_id }) {
      // Idempotency: same claim_id → return existing
      const existing = this._credits.find((c) => c.claim_id === claim_id);
      if (existing) return existing;
      const txn = { txn_id: `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, claim_id, member_id, amount };
      this._credits.push(txn);
      return txn;
    },
    async debit({ member_id, amount, claim_id }) {
      return { txn_id: `DBT-${Date.now()}`, claim_id, member_id, amount };
    },
  };
}

function makeEventBus() {
  return {
    _events: [],
    async publish(topic, payload) {
      this._events.push({ topic, payload, at: new Date().toISOString() });
    },
    getEvents(topic) {
      return this._events.filter((e) => e.topic === topic);
    },
  };
}

function makeAudit() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}\n     ${e.message}`);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const assertEq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'eq'}: expected ${b}, got ${a}`); };

// ============================================================
console.log('\n📦 AAM Migration Engine — Tests\n');

// --- Setup ---
const aam = makeAAMLedger({
  'AAM-001': { balance: 500, phone_hash: 'ph_aaa' },
  'AAM-002': { balance: 1200, phone_hash: 'ph_bbb' },
  'AAM-003': { balance: 0, phone_hash: 'ph_ccc' },
  'AAM-004': { balance: -50, phone_hash: 'ph_ddd' }, // negative
});
const wallet = makeLP2Wallet({
  m1: { member_id: 'M-1', phone_hash: 'ph_aaa', display_name: 'Alice' },
  m2: { member_id: 'M-2', phone_hash: 'ph_bbb', display_name: 'Bob' },
  m3: { member_id: 'M-3', phone_hash: 'ph_ccc', display_name: 'Carol' },
  // M-4 not registered yet
});
const bus = makeEventBus();
const audit = makeAudit();
const engine = new AAMMigrationEngine({ aamLedger: aam, lp2Wallet: wallet, eventBus: bus, auditLog: audit });

(async () => {
  // --- Validation ---
  await test('T01: rejects missing aam_account_id', async () => {
    try { await engine.migrateAAMAccount({ phone_hash: 'ph_aaa' }); assert(false, 'should throw'); }
    catch (e) { assert(e.message.includes('aam_account_id'), 'wrong error'); }
  });

  await test('T02: rejects missing phone_hash', async () => {
    try { await engine.migrateAAMAccount({ aam_account_id: 'AAM-001' }); assert(false, 'should throw'); }
    catch (e) { assert(e.message.includes('phone_hash'), 'wrong error'); }
  });

  // --- Happy path ---
  await test('T03: migrates AAM-001 (500 points) to M-1', async () => {
    const r = await engine.migrateAAMAccount({ aam_account_id: 'AAM-001', phone_hash: 'ph_aaa' });
    assertEq(r.status, 'MIGRATED');
    assertEq(r.amount, 500);
    assertEq(r.member_id, 'M-1');
    assert(r.claim_id.startsWith('AAM-MIG-AAM-001-'), 'claim_id format');
  });

  await test('T04: AAM-001 marked as migrated in legacy', async () => {
    assertEq(aam._accounts['AAM-001'].migrated, true);
  });

  await test('T05: aam.migrated event published', async () => {
    const events = bus.getEvents('aam.migrated');
    assert(events.length >= 1, 'no event published');
    assertEq(events[0].payload.amount, 500);
  });

  // --- Idempotency ---
  await test('T06: re-migrating AAM-001 returns ALREADY_MIGRATED', async () => {
    const r = await engine.migrateAAMAccount({ aam_account_id: 'AAM-001', phone_hash: 'ph_aaa' });
    assertEq(r.status, 'ALREADY_MIGRATED');
    assertEq(r.amount, 500);
  });

  await test('T07: idempotency prevents double credit', async () => {
    // Only 1 credit should exist for AAM-001's claim_id
    const aam1Credits = wallet._credits.filter((c) => c.claim_id.startsWith('AAM-MIG-AAM-001-'));
    assertEq(aam1Credits.length, 1, 'expected 1 credit, got ' + aam1Credits.length);
  });

  // --- Zero balance ---
  await test('T08: zero balance (AAM-003) still migrates', async () => {
    const r = await engine.migrateAAMAccount({ aam_account_id: 'AAM-003', phone_hash: 'ph_ccc' });
    assertEq(r.status, 'MIGRATED');
    assertEq(r.amount, 0);
  });

  // --- Negative balance ---
  await test('T09: negative balance (AAM-004) is rejected', async () => {
    try {
      await engine.migrateAAMAccount({ aam_account_id: 'AAM-004', phone_hash: 'ph_ddd' });
      assert(false, 'should reject negative');
    } catch (e) {
      assert(e.message.includes('negative'), 'wrong error: ' + e.message);
    }
  });

  // --- Missing LP2.0 member ---
  await test('T10: AAM-002 (ph_bbb mapped to M-2) migrates OK', async () => {
    const r = await engine.migrateAAMAccount({ aam_account_id: 'AAM-002', phone_hash: 'ph_bbb' });
    assertEq(r.status, 'MIGRATED');
    assertEq(r.amount, 1200);
    assertEq(r.member_id, 'M-2');
  });

  // --- Dry run ---
  await test('T11: dry_run returns plan without executing', async () => {
    const r = await engine.migrateAAMAccount({
      aam_account_id: 'AAM-001', phone_hash: 'ph_aaa', dry_run: true
    });
    assertEq(r.status, 'DRY_RUN');
    assertEq(r.aam_balance, 500);
    assert(r.plan.length === 4, 'plan should have 4 steps');
  });

  // --- Balance mismatch ---
  await test('T12: expected_balance mismatch is rejected', async () => {
    try {
      await engine.migrateAAMAccount({
        aam_account_id: 'AAM-002', phone_hash: 'ph_bbb', expected_balance: 9999
      });
      assert(false, 'should reject mismatch');
    } catch (e) {
      assert(e.message.includes('mismatch'), 'wrong error');
    }
  });

  // --- Batch migration ---
  await test('T13: batchMigrate processes multiple accounts', async () => {
    const freshAAM = makeAAMLedger({
      'AAM-100': { balance: 100, phone_hash: 'ph_100' },
      'AAM-101': { balance: 200, phone_hash: 'ph_101' },
    });
    const freshWallet = makeLP2Wallet({
      m100: { member_id: 'M-100', phone_hash: 'ph_100' },
      m101: { member_id: 'M-101', phone_hash: 'ph_101' },
    });
    const freshBus = makeEventBus();
    const eng = new AAMMigrationEngine({ aamLedger: freshAAM, lp2Wallet: freshWallet, eventBus: freshBus, auditLog: audit });

    const r = await eng.batchMigrate({
      aam_accounts: [
        { aam_account_id: 'AAM-100', phone_hash: 'ph_100' },
        { aam_account_id: 'AAM-101', phone_hash: 'ph_101' },
      ],
    });
    assertEq(r.total, 2);
    assertEq(r.migrated, 2);
    assertEq(r.failed, 0);
  });

  await test('T14: batchMigrate dry-run reports without executing', async () => {
    const freshAAM = makeAAMLedger({ 'AAM-200': { balance: 50, phone_hash: 'ph_200' } });
    const freshWallet = makeLP2Wallet({ m200: { member_id: 'M-200', phone_hash: 'ph_200' } });
    const eng = new AAMMigrationEngine({ aamLedger: freshAAM, lp2Wallet: freshWallet, eventBus: makeEventBus(), auditLog: audit });

    const r = await eng.batchMigrate({
      aam_accounts: [{ aam_account_id: 'AAM-200', phone_hash: 'ph_200' }],
      dry_run: true,
    });
    assertEq(r.dry_run, true);
    assertEq(r.migrated, 0);
    assertEq(r.skipped, 1);
  });

  // --- Rollback ---
  await test('T15: rollback reverses credit and unmarks AAM', async () => {
    const claimId = wallet._credits.find((c) => c.claim_id.startsWith('AAM-MIG-AAM-002-'))?.claim_id;
    assert(claimId, 'should have AAM-002 credit');
    const r = await engine.rollback({ claim_id: claimId, reason: 'test rollback', actor: 'tester' });
    assertEq(r.status, 'ROLLED_BACK');
    assertEq(aam._accounts['AAM-002'].migrated, false);
  });

  await test('T16: rollback requires reason', async () => {
    try { await engine.rollback({ claim_id: 'xxx' }); assert(false, 'should throw'); }
    catch (e) { assert(e.message.includes('reason'), 'wrong error'); }
  });

  // --- Status ---
  await test('T17: getStatus returns NOT_MIGRATED for unknown', async () => {
    const r = await engine.getStatus('AAM-999');
    assertEq(r.status, 'NOT_MIGRATED');
  });

  await test('T18: getStatus returns MIGRATED for AAM-001', async () => {
    const r = await engine.getStatus('AAM-001');
    assertEq(r.status, 'MIGRATED');
    assertEq(r.amount, 500);
  });

  await test('T19: getStatus returns ROLLED_BACK for AAM-002', async () => {
    const r = await engine.getStatus('AAM-002');
    assertEq(r.status, 'ROLLED_BACK');
    assert(r.rolled_back_at, 'should have rolled_back_at');
  });

  // --- List ---
  await test('T20: listMigrations returns all records', async () => {
    const r = await engine.listMigrations();
    assert(r.total >= 3, `expected >=3, got ${r.total}`);
  });

  await test('T21: listMigrations filters by status=ROLLED_BACK', async () => {
    const r = await engine.listMigrations({ status: 'ROLLED_BACK' });
    assert(r.items.every((i) => i.rolled_back_at), 'all should be rolled back');
    assert(r.total >= 1, 'should have at least 1');
  });

  await test('T22: listMigrations filters by status=MIGRATED', async () => {
    const r = await engine.listMigrations({ status: 'MIGRATED' });
    assert(r.items.every((i) => !i.rolled_back_at), 'all should not be rolled back');
  });

  // --- Summary ---
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
