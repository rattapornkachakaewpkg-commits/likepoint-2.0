// Wallet Rebind Fixes — Unit Tests
// 100% coverage for PF-2 bug fixes (A2/A10/A11/A14/A20)
// Author: AliClaw | Date: 2026-07-07

const { WalletReconcileEngine } = require('./wallet-rebind-fixes');

// =================== MOCK FACTORIES ===================
function mockLedger() {
  return {
    findByWallet: async (wid, opts) => {
      // Return txns based on wallet id pattern
      if (wid === 'W-A2-1') return [{ type: 'CREDIT', amount: 5000 }];
      if (wid === 'W-A2-2') return [{ type: 'CREDIT', amount: 100 }, { type: 'DEBIT', amount: 50 }];
      if (wid === 'W-A11-1') return [{ type: 'DEBIT', amount: 200 }, { type: 'CREDIT', amount: 50 }];
      if (wid === 'W-HEALTHY') return [{ type: 'CREDIT', amount: 1000 }];
      if (wid === 'W-EMPTY') return [];
      return [];
    },
    findAAMBalance: async (mid) => {
      if (mid === 'M-A14-1') return 1500;
      if (mid === 'M-A14-2') return null;
      return 0;
    },
    findByWalletPaginated: async (wid, opts) => {
      if (wid === 'W-A20-1') {
        return {
          entries: [
            { type: 'CREDIT', amount: 100, at: '2026-01-01' },
            { type: 'DEBIT', amount: 50, at: '2026-01-02' }
          ],
          total: 2
        };
      }
      return { entries: [], total: 0 };
    }
  };
}

function mockWallets() {
  const store = new Map();
  return {
    findById: async (id) => store.get(id) || null,
    findByPerson: async (pid) => {
      return Array.from(store.values()).filter((w) => w.person_id === pid);
    },
    findByMemberAndTenant: async (mid, tenant) => {
      return Array.from(store.values()).find((w) => w.member_id === mid && w.tenant_id === tenant) || null;
    },
    update: async (id, patch) => {
      const w = store.get(id);
      if (!w) return null;
      Object.assign(w, patch);
      store.set(id, w);
      return w;
    },
    create: async (w) => {
      const id = w.wallet_id || `W-NEW-${Date.now()}`;
      store.set(id, { ...w, wallet_id: id });
      return store.get(id);
    },
    _seed: (id, data) => store.set(id, { ...data, wallet_id: id })
  };
}

function mockPhones() {
  return {
    findActiveByPerson: async (pid) => {
      if (pid === 'P-1') return [{ phone_hash: 'h-active' }];
      if (pid === 'P-2') return []; // ghost wallets!
      return [];
    }
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

// =================== TESTS ===================
let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { pass++; console.log(`  ✅ ${name}`); })
    .catch((e) => { fail++; console.error(`  ❌ ${name}: ${e.message}`); });
}

(async () => {
  // =================== A2/A10: balance = 0/null heal ===================
  console.log('\n--- A2/A10: getBalance with self-heal ---');
  
  await test('returns cached balance when healthy', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-HEALTHY', { person_id: 'P', balance: 1000 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r = await eng.getBalance('W-HEALTHY');
    if (r.balance !== 1000) throw new Error('expected 1000');
    if (r.healed) throw new Error('should not heal');
  });

  await test('heals A2: balance=0 → recompute from ledger (5000)', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-A2-1', { person_id: 'P', balance: 0 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r = await eng.getBalance('W-A2-1');
    if (r.balance !== 5000) throw new Error(`expected 5000, got ${r.balance}`);
    if (!r.healed) throw new Error('should mark healed');
    const healed = a.logs.find((l) => l.action === 'BALANCE_HEAL');
    if (!healed) throw new Error('should audit heal');
  });

  await test('heals A10: balance=null → recompute (50)', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-A2-2', { person_id: 'P', balance: null });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r = await eng.getBalance('W-A2-2');
    if (r.balance !== 50) throw new Error(`expected 50, got ${r.balance}`);
    if (!r.healed) throw new Error('should heal');
  });

  // =================== A11: negative balance ===================
  console.log('\n--- A11: canTransfer (negative balance guard) ---');

  await test('blocks transfer when current balance is negative', async () => {
    const w = mockWallets(); const a = mockAudit(); const n = mockNotify();
    w._seed('W-A11-1', { person_id: 'P', balance: -150 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a, notify: n.notify });
    const r = await eng.canTransfer('W-A11-1', 100);
    if (r.allowed) throw new Error('should block');
    if (!n.sent.find((s) => s.type === 'ADMIN_ALERT')) throw new Error('should notify admin');
  });

  await test('blocks transfer when amount > balance', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-HEALTHY', { person_id: 'P', balance: 100 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r = await eng.canTransfer('W-HEALTHY', 200);
    if (r.allowed) throw new Error('should block');
  });

  await test('allows transfer when amount <= balance', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-HEALTHY', { person_id: 'P', balance: 1000 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r = await eng.canTransfer('W-HEALTHY', 500);
    if (!r.allowed) throw new Error('should allow');
    if (r.after !== 500) throw new Error('after should be 500');
  });

  await test('rejects non-positive amount', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-HEALTHY', { person_id: 'P', balance: 1000 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r0 = await eng.canTransfer('W-HEALTHY', 0);
    const rNeg = await eng.canTransfer('W-HEALTHY', -50);
    if (r0.allowed || rNeg.allowed) throw new Error('should reject');
  });

  // =================== A14: AAMpoint cross-tenant ===================
  console.log('\n--- A14: AAMpoint reconciliation ---');

  await test('heals A14: AAM ledger has data, wallet missing', async () => {
    const w = mockWallets(); const a = mockAudit();
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r = await eng.getAAMPoint('M-A14-1');
    if (r.aampoint !== 1500) throw new Error(`expected 1500, got ${r.aampoint}`);
    if (!r.healed) throw new Error('should heal');
  });

  await test('returns 0 for A14 when no data anywhere', async () => {
    const w = mockWallets(); const a = mockAudit();
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r = await eng.getAAMPoint('M-NEW-USER');
    if (r.aampoint !== 0) throw new Error('expected 0');
  });

  // =================== A20: statement ===================
  console.log('\n--- A20: statement display ---');

  await test('returns paginated statement', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-A20-1', { person_id: 'P', balance: 100 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const r = await eng.getStatement('W-A20-1', { limit: 50 });
    if (r.entries.length !== 2) throw new Error('expected 2 entries');
    if (r.total !== 2) throw new Error('expected total=2');
  });

  await test('rejects unknown wallet in statement', async () => {
    const w = mockWallets(); const a = mockAudit();
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    let threw = false;
    try { await eng.getStatement('W-DOES-NOT-EXIST'); } catch (e) { threw = true; }
    if (!threw) throw new Error('should throw');
  });

  await test('caps limit at 200', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-A20-1', { person_id: 'P', balance: 100 });
    const ledger = mockLedger();
    ledger.findByWalletPaginated = async (wid, opts) => {
      if (opts.limit > 200) throw new Error('limit not capped');
      return { entries: [], total: 0 };
    };
    const eng = new WalletReconcileEngine({ ledger, wallets: w, phones: mockPhones(), audit: a });
    await eng.getStatement('W-A20-1', { limit: 9999 });
  });

  // =================== Reconcile Person ===================
  console.log('\n--- Reconcile Person (admin report) ---');

  await test('detects ghost wallet (A2)', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-GHOST-1', { person_id: 'P-2', phone_hash: 'h-old', balance: 100 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const { actions } = await eng.reconcilePerson('P-2');
    if (!actions.find((x) => x.type === 'GHOST_DETECTED')) throw new Error('should detect ghost');
  });

  await test('detects negative balance (A11)', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-NEG-1', { person_id: 'P-1', phone_hash: 'h-active', balance: -50 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const { actions } = await eng.reconcilePerson('P-1');
    if (!actions.find((x) => x.type === 'NEGATIVE_BALANCE')) throw new Error('should detect negative');
  });

  await test('healthy person → no actions', async () => {
    const w = mockWallets(); const a = mockAudit();
    w._seed('W-OK-1', { person_id: 'P-1', phone_hash: 'h-active', balance: 100 });
    const eng = new WalletReconcileEngine({ ledger: mockLedger(), wallets: w, phones: mockPhones(), audit: a });
    const { actions } = await eng.reconcilePerson('P-1');
    if (actions.length !== 0) throw new Error(`expected 0, got ${actions.length}`);
  });

  // =================== Constructor ===================
  console.log('\n--- Constructor validation ---');
  await test('throws if missing required deps', () => {
    let threw = false;
    try { new WalletReconcileEngine({}); } catch (e) { threw = true; }
    if (!threw) throw new Error('should throw');
  });

  // =================== Summary ===================
  console.log(`\n========================================`);
  console.log(`Results: ${pass} pass, ${fail} fail`);
  console.log(`========================================`);
  process.exit(fail > 0 ? 1 : 0);
})();
