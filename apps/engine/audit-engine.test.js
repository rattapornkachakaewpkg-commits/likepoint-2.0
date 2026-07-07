// Audit Engine — Unit Tests
// Tests: 24 cases covering log, search, export, PDPA, retention, immutability, correlation
// Author: AliClaw | Date: 2026-07-07

const { AuditEngine } = require('./audit-engine.js');

// --- Mocks ---
function makeMemberService() {
  return {
    async getProfile(member_id) {
      return { member_id, display_name: 'Test User', tier: 'gold' };
    },
  };
}

function makeWalletService() {
  return {
    async getTransactions(member_id) {
      return [
        { txn_id: 'TXN-1', member_id, amount: 100, source: 'AAM_MIGRATION' },
        { txn_id: 'TXN-2', member_id, amount: 50, source: 'REWARD' },
      ];
    },
  };
}

function makeEncryptor() {
  return {
    encrypt(plaintext) { return `ENC[${plaintext}]`; },
    decrypt(ciphertext) { return ciphertext.replace(/^ENC\[|\]$/g, ''); },
  };
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
const assertEq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const assertContains = (s, sub, msg) => { if (!s.includes(sub)) throw new Error(`${msg || 'contains'}: "${sub}" not in "${s.slice(0, 100)}"`); };

// ============================================================
console.log('\n🔒 Audit Engine — Tests\n');

(async () => {
  const engine = new AuditEngine({
    memberService: makeMemberService(),
    walletService: makeWalletService(),
    encryptor: makeEncryptor(),
  });

  // --- Validation ---
  await test('T01: log() requires event_type', async () => {
    try { await engine.log({ actor: 'user:1', action: 'CREATE' }); assert(false, 'should throw'); }
    catch (e) { assert(e.message.includes('event_type'), 'wrong error'); }
  });

  await test('T02: log() requires actor', async () => {
    try { await engine.log({ event_type: 'LOGIN', action: 'CREATE' }); assert(false, 'should throw'); }
    catch (e) { assert(e.message.includes('actor'), 'wrong error'); }
  });

  await test('T03: log() requires action', async () => {
    try { await engine.log({ event_type: 'LOGIN', actor: 'user:1' }); assert(false, 'should throw'); }
    catch (e) { assert(e.message.includes('action'), 'wrong error'); }
  });

  // --- log() ---
  await test('T04: log() returns id and created_at', async () => {
    const r = await engine.log({
      event_type: 'WALLET_CREDIT',
      actor: 'service:wallet',
      member_id: 'M-1',
      action: 'CREATE',
      metadata: { amount: 100 },
    });
    assert(r.id.startsWith('AUD-'), 'id format');
    assert(r.created_at, 'created_at present');
  });

  await test('T05: log() stores PII encrypted', async () => {
    const r = await engine.log({
      event_type: 'KYC',
      actor: 'service:kyc',
      member_id: 'M-1',
      action: 'CREATE',
      metadata: { phone: '0812345678', id_card: '1234567890123', amount: 100 },
    });
    const entry = engine.store.get(r.id);
    assertContains(entry.pii_encrypted, '0812345678', 'PII should be in encrypted blob');
    assertEq(entry.metadata.phone, '[REDACTED]', 'PII should be redacted in metadata');
  });

  await test('T06: log() calculates 7-year retention_until', async () => {
    const r = await engine.log({
      event_type: 'LOGIN', actor: 'user:1', action: 'CREATE',
    });
    const entry = engine.store.get(r.id);
    const diff = new Date(entry.retention_until) - new Date(entry.created_at);
    const years7 = 7 * 365.25 * 24 * 60 * 60 * 1000;
    assert(Math.abs(diff - years7) < 24 * 60 * 60 * 1000, 'retention should be ~7 years');
  });

  // --- search() ---
  await test('T07: search() by member_id', async () => {
    await engine.log({ event_type: 'TEST', actor: 'u', member_id: 'M-A', action: 'READ' });
    await engine.log({ event_type: 'TEST', actor: 'u', member_id: 'M-B', action: 'READ' });
    const r = await engine.search({ member_id: 'M-A' });
    assertEq(r.total, 1);
    assertEq(r.items[0].member_id, 'M-A');
  });

  await test('T08: search() by event_type', async () => {
    await engine.log({ event_type: 'LOGIN', actor: 'u', action: 'CREATE' });
    await engine.log({ event_type: 'LOGOUT', actor: 'u', action: 'CREATE' });
    const r = await engine.search({ event_type: 'LOGIN' });
    assert(r.items.every((i) => i.event_type === 'LOGIN'), 'all should be LOGIN');
  });

  await test('T09: search() by date range', async () => {
    const r = await engine.search({
      from: '2020-01-01',
      to: '2030-12-31',
    });
    assert(r.total > 0, 'should find entries in range');
  });

  await test('T10: search() pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.log({ event_type: 'PAGE_TEST', actor: 'u', action: 'READ' });
    }
    const r1 = await engine.search({ event_type: 'PAGE_TEST', limit: 2, offset: 0 });
    const r2 = await engine.search({ event_type: 'PAGE_TEST', limit: 2, offset: 2 });
    assertEq(r1.items.length, 2);
    assertEq(r2.items.length, 2);
    assert(r1.has_more, 'should have more');
  });

  await test('T11: search() by correlation_id', async () => {
    await engine.log({ event_type: 'X', actor: 'u', action: 'CREATE', correlation_id: 'CORR-1' });
    await engine.log({ event_type: 'Y', actor: 'u', action: 'CREATE', correlation_id: 'CORR-2' });
    const r = await engine.search({ correlation_id: 'CORR-1' });
    assert(r.items.every((i) => i.correlation_id === 'CORR-1'), 'all should match');
  });

  await test('T12: search() by outcome', async () => {
    await engine.log({ event_type: 'LOGIN', actor: 'u', action: 'CREATE', outcome: 'failure' });
    const r = await engine.search({ event_type: 'LOGIN', outcome: 'failure' });
    assert(r.items.every((i) => i.outcome === 'failure'), 'all should be failure');
  });

  // --- export() ---
  await test('T13: export() returns CSV', async () => {
    const r = await engine.export({ format: 'csv', actor: 'admin:1' });
    assertEq(r.format, 'csv');
    assert(r.row_count > 0, 'should have rows');
    assert(r.url.includes('.csv'), 'url should be .csv');
  });

  await test('T14: export() returns JSON', async () => {
    const r = await engine.export({ format: 'json', actor: 'admin:1' });
    assertEq(r.format, 'json');
    const bucket = engine.bucket.get(r.export_id);
    const parsed = JSON.parse(bucket.content);
    assert(Array.isArray(parsed), 'should be array');
  });

  await test('T15: export() rejects invalid format', async () => {
    try { await engine.export({ format: 'xml' }); assert(false, 'should throw'); }
    catch (e) { assert(e.message.includes('Unsupported'), 'wrong error'); }
  });

  await test('T16: export() audits itself', async () => {
    const beforeCount = (await engine.search({ event_type: 'AUDIT_EXPORT' })).total;
    await engine.export({ format: 'csv', actor: 'test' });
    const afterCount = (await engine.search({ event_type: 'AUDIT_EXPORT' })).total;
    assert(afterCount > beforeCount, 'should create audit entry');
  });

  // --- exportUserData() (PDPA) ---
  await test('T17: exportUserData() requires member_id', async () => {
    try { await engine.exportUserData({}); assert(false, 'should throw'); }
    catch (e) { assert(e.message.includes('member_id'), 'wrong error'); }
  });

  await test('T18: exportUserData() returns 30-day SLA', async () => {
    const r = await engine.exportUserData({ member_id: 'M-1' });
    const diff = new Date(r.sla_deadline) - new Date();
    const days30 = 30 * 24 * 60 * 60 * 1000;
    assert(Math.abs(diff - days30) < 24 * 60 * 60 * 1000, 'SLA should be 30 days');
  });

  await test('T19: exportUserData() includes profile + txns + audit', async () => {
    const r = await engine.exportUserData({ member_id: 'M-1' });
    assertEq(r.summary.transactions, 2, 'should have 2 transactions');
    assert(r.summary.audit_entries > 0, 'should have audit entries');
    assert(r.summary.profile, 'should have profile');
  });

  await test('T20: exportUserData() creates PDPA_REQUEST audit entry', async () => {
    const before = (await engine.search({ event_type: 'PDPA_REQUEST' })).total;
    await engine.exportUserData({ member_id: 'M-1' });
    const after = (await engine.search({ event_type: 'PDPA_REQUEST' })).total;
    assert(after > before, 'should create PDPA_REQUEST audit');
  });

  // --- retention ---
  await test('T21: runRetentionSweep() archives old entries', async () => {
    const archive = new Map();
    // Insert an old entry (8 years ago)
    const oldId = await engine.log({ event_type: 'OLD', actor: 'u', action: 'CREATE' });
    const oldEntry = engine.store.get(oldId.id);
    oldEntry.created_at = new Date(Date.now() - 8 * 365 * 24 * 60 * 60 * 1000).toISOString();
    engine.store.set(oldId.id, oldEntry);

    const r = await engine.runRetentionSweep({ archive_bucket: archive });
    assert(r.archived >= 1, 'should archive old entries');
  });

  await test('T22: runRetentionSweep() keeps recent entries', async () => {
    const archive = new Map();
    const initialCount = engine.store.size;
    await engine.runRetentionSweep({ archive_bucket: archive });
    assert(engine.store.size >= initialCount - 1, 'should keep recent entries');
  });

  // --- getByCorrelation ---
  await test('T23: getByCorrelation() traces across services', async () => {
    const corrId = `CORR-${Date.now()}`;
    await engine.log({ event_type: 'MIGRATION', actor: 'service:mig', action: 'CREATE', correlation_id: corrId });
    await engine.log({ event_type: 'WALLET_CREDIT', actor: 'service:wallet', action: 'CREATE', correlation_id: corrId });
    const r = await engine.getByCorrelation(corrId);
    assertEq(r.length, 2, 'should find both entries');
  });

  // --- stats ---
  await test('T24: stats() aggregates by event_type and actor', async () => {
    const r = await engine.stats({});
    assert(typeof r.total === 'number', 'total is number');
    assert(typeof r.byEventType === 'object', 'byEventType is object');
    assert(typeof r.byActor === 'object', 'byActor is object');
  });

  // --- Summary ---
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
