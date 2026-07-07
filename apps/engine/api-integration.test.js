// API Integration — Tests
const { APIIntegrationLayer } = require('./api-integration.js');
const { SessionGuard } = require('./session-guard.js');
const { TokenValidator } = require('./bug-fixes.js');

function makeAudit() { return { _l: [], async log(e) { this._l.push(e); } }; }
function makeMembers() { return { _m: new Map([['M-1', { member_id: 'M-1' }]]), async get(id) { return this._m.get(id); } }; }

let p = 0, f = 0;
const test = async (name, fn) => { try { await fn(); p++; console.log(`  ✅ ${name}`); } catch (e) { f++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

(async () => {
  const audit = makeAudit();
  const members = makeMembers();
  const guard = new SessionGuard({ auditEngine: audit, memberService: { get: async (id) => members._m.get(id) } });
  await guard.addReviewer?.({ reviewer_id: 'M-1' }); // noop
  const layer = new APIIntegrationLayer({ sessionGuard: guard, auditEngine: audit, memberService: { get: async (id) => members._m.get(id) } });

  // Mock engine
  class MockEngine {
    async deposit({ member_id, amount }) {
      return { member_id, amount, status: 'deposited' };
    }
    async fail() { throw new Error('engine error'); }
  }
  const engine = new MockEngine();

  // Setup session
  const session = await guard.createSession({ member_id: 'M-1', metadata: { tier: 'pro', features: ['lotto_weekly'] } });
  const token = TokenValidator.create({ claims: { sub: 'M-1' } });

  await test('T01: healthCheck returns ok', async () => {
    const r = await layer.healthCheck();
    assertEq(r.status, 'ok');
  });
  await test('T02: protectedHandler requires token', async () => {
    const r = await layer.protectedHandler({ engine, method: 'deposit', args: [{ member_id: 'M-1', amount: 100 }] });
    assertEq(r.status, 401);
  });
  await test('T03: protectedHandler requires session', async () => {
    const r = await layer.protectedHandler({ token, engine, method: 'deposit', args: [{ member_id: 'M-1', amount: 100 }] });
    assertEq(r.status, 401);
  });
  await test('T04: protectedHandler success', async () => {
    const r = await layer.protectedHandler({ token, session_id: session.session_id, engine, method: 'deposit', args: [{ member_id: 'M-1', amount: 100 }] });
    assertEq(r.status, 200);
    assertEq(r.body.result.status, 'deposited');
  });
  await test('T05: protectedHandler with idempotency_key (miss)', async () => {
    const r = await layer.protectedHandler({ token, session_id: session.session_id, idempotency_key: 'IDEM-NEW-2', engine, method: 'deposit', args: [{ member_id: 'M-1', amount: 100 }] });
    assertEq(r.hit, false);
    assertEq(r.result.body.idempotent, false);
  });
  await test('T06: protectedHandler with idempotency_key (hit)', async () => {
    const r = await layer.protectedHandler({ token, session_id: session.session_id, idempotency_key: 'IDEM-NEW-2', engine, method: 'deposit', args: [{ member_id: 'M-1', amount: 100 }] });
    assertEq(r.body.idempotent, true);
  });
  await test('T07: protectedHandler with requiredFeature (pass)', async () => {
    const r = await layer.protectedHandler({ token, session_id: session.session_id, requiredFeature: 'lotto_weekly', engine, method: 'deposit', args: [{ member_id: 'M-1', amount: 100 }] });
    assertEq(r.status, 200);
  });
  await test('T08: protectedHandler with requiredFeature (fail)', async () => {
    const r = await layer.protectedHandler({ token, session_id: session.session_id, requiredFeature: 'unknown_feature', engine, method: 'deposit', args: [{ member_id: 'M-1', amount: 100 }] });
    assertEq(r.status, 403);
  });
  await test('T09: protectedHandler catches engine error', async () => {
    try {
      await layer.protectedHandler({ token, session_id: session.session_id, engine, method: 'fail' });
      assert(false, 'should throw');
    } catch (e) { assertContains(e.message, 'engine error'); }
    const failLog = audit._l.find((l) => l.event_type === 'API_CALL_FAILED');
    assert(failLog, 'failure audited');
  });
  await test('T10: protectedHandler success is audited', async () => {
    await layer.protectedHandler({ token, session_id: session.session_id, engine, method: 'deposit', args: [{ member_id: 'M-1', amount: 100 }] });
    const successLog = audit._l.find((l) => l.event_type === 'API_CALL_SUCCESS');
    assert(successLog, 'success audited');
  });
  await test('T11: validateAmount helper', async () => {
    assertEq(layer.validateAmount(100, { min: 0 }), 100);
    try { layer.validateAmount(-1); assert(false); } catch (e) { /* expected */ }
  });
  await test('T12: redact helper', async () => {
    const r = layer.redact({ pin: '123456' });
    assertEq(r.pin, '[REDACTED]');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${p}/${p + f} passed${f ? `, ${f} failed` : ''}`);
  process.exit(f > 0 ? 1 : 0);
})();
