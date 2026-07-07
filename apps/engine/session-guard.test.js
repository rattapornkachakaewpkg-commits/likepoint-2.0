// Session Guard — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { SessionGuard } = require('./session-guard.js');
const { TokenValidator } = require('./bug-fixes.js');

function makeAudit() { return { _l: [], async log(e) { this._l.push(e); return { id: 'a' }; } }; }
function makeBus() { return { _e: [], async publish(t, p) { this._e.push({ t, p }); } }; }

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n🛡️ Session Guard — Tests\n');

(async () => {
  const audit = makeAudit();
  const bus = makeBus();
  const guard = new SessionGuard({ auditEngine: audit, eventBus: bus });

  // === withIdempotency ===
  await test('T01: withIdempotency requires key', async () => {
    try { await guard.withIdempotency({ onMiss: async () => 'x' }); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: withIdempotency miss → executes handler', async () => {
    let called = 0;
    const r = await guard.withIdempotency({
      key: 'k1',
      onMiss: async () => { called++; return 'result-1'; },
    });
    assertEq(r.hit, false);
    assertEq(r.result, 'result-1');
    assertEq(called, 1);
  });

  await test('T03: withIdempotency hit → returns existing result', async () => {
    let called = 0;
    const r1 = await guard.withIdempotency({ key: 'k2', onMiss: async () => { called++; return 'first'; } });
    const r2 = await guard.withIdempotency({ key: 'k2', onMiss: async () => { called++; return 'second'; } });
    assertEq(r1.hit, false);
    assertEq(r2.hit, true);
    assertEq(r2.result, 'first');
    assertEq(called, 1, 'handler called only once');
  });

  await test('T04: withIdempotency with custom onHit callback', async () => {
    await guard.withIdempotency({ key: 'k3', onMiss: async () => 'x' });
    const r = await guard.withIdempotency({
      key: 'k3',
      onHit: (existing) => ({ custom: true, result: existing.result }),
      onMiss: async () => 'y',
    });
    assertEq(r.custom, true);
    assertEq(r.result, 'x');
  });

  await test('T05: withIdempotency serializes parallel same-key', async () => {
    let called = 0;
    const fns = Array.from({ length: 5 }, () => guard.withIdempotency({
      key: 'parallel',
      onMiss: async () => { await new Promise((r) => setTimeout(r, 5)); called++; return 'x'; },
    }));
    await Promise.all(fns);
    assertEq(called, 1, 'handler called only once for parallel');
  });

  // === requireAuth ===
  await test('T06: requireAuth rejects no token', async () => {
    const r = await guard.requireAuth({ token: null });
    assertEq(r.ok, false);
    assertEq(r.status, 401);
    assertEq(r.reason, 'MISSING_TOKEN');
  });

  await test('T07: requireAuth rejects invalid token', async () => {
    const r = await guard.requireAuth({ token: { foo: 'bar' } });
    assertEq(r.reason, 'NO_EXPIRY_SET');
  });

  await test('T08: requireAuth accepts valid token', async () => {
    const token = TokenValidator.create({ claims: { sub: 'u1', role: 'admin' } });
    const r = await guard.requireAuth({ token, requiredClaims: ['sub', 'role'] });
    assertEq(r.ok, true);
    assertEq(r.claims.sub, 'u1');
  });

  await test('T09: requireAuth rejects missing claim', async () => {
    const token = TokenValidator.create({ claims: { sub: 'u1' } });
    const r = await guard.requireAuth({ token, requiredClaims: ['sub', 'role'] });
    assertEq(r.reason, 'MISSING_CLAIM:role');
  });

  await test('T10: requireAuth rejects expired token', async () => {
    const token = TokenValidator.create({ claims: { sub: 'u1' }, ttlSeconds: -60 });
    const r = await guard.requireAuth({ token });
    assertEq(r.reason, 'EXPIRED');
  });

  // === requireFeature ===
  await test('T11: requireFeature rejects no member', async () => {
    const r = await guard.requireFeature({ member: null, feature: 'lotto' });
    assertEq(r.reason, 'NO_MEMBER');
  });

  await test('T12: requireFeature accepts when feature present', async () => {
    const r = await guard.requireFeature({ member: { member_id: 'M-1', features: ['lotto', 'premium_poi'] }, feature: 'lotto' });
    assertEq(r.ok, true);
  });

  await test('T13: requireFeature rejects missing feature', async () => {
    const r = await guard.requireFeature({ member: { member_id: 'M-1', features: [] }, feature: 'lotto' });
    assertEq(r.reason, 'REQUIRES_FEATURE_LOTTO');
  });

  await test('T14: requireFeature enforces minTier (pro)', async () => {
    const r1 = await guard.requireFeature({ member: { member_id: 'M-1', tier: 'pro', features: [] }, minTier: 'pro' });
    assertEq(r1.ok, true);
    const r2 = await guard.requireFeature({ member: { member_id: 'M-1', tier: 'free', features: [] }, minTier: 'pro' });
    assertEq(r2.reason, 'REQUIRES_TIER_PRO');
  });

  await test('T15: requireFeature tier ordering (free < pro < enterprise)', async () => {
    const r1 = await guard.requireFeature({ member: { tier: 'pro' }, minTier: 'free' });
    assertEq(r1.ok, true);
    const r2 = await guard.requireFeature({ member: { tier: 'pro' }, minTier: 'enterprise' });
    assertEq(r2.reason, 'REQUIRES_TIER_ENTERPRISE');
  });

  // === validateSession ===
  await test('T16: validateSession rejects no session_id', async () => {
    const r = await guard.validateSession({ session_id: null });
    assertEq(r.reason, 'NO_SESSION');
  });

  await test('T17: validateSession rejects unknown session', async () => {
    const r = await guard.validateSession({ session_id: 'NOPE' });
    assertEq(r.reason, 'INVALID_SESSION');
  });

  await test('T18: validateSession accepts valid session', async () => {
    const s = await guard.createSession({ member_id: 'M-1', ip_address: '1.2.3.4', device_id: 'dev-1' });
    const r = await guard.validateSession({ session_id: s.session_id, current_ip: '1.2.3.4', current_device_id: 'dev-1' });
    assertEq(r.ok, true);
  });

  await test('T19: validateSession rejects IP mismatch', async () => {
    const s = await guard.createSession({ member_id: 'M-1', ip_address: '1.2.3.4' });
    const r = await guard.validateSession({ session_id: s.session_id, current_ip: '5.6.7.8' });
    assertEq(r.reason, 'IP_MISMATCH');
  });

  await test('T20: validateSession rejects device mismatch', async () => {
    const s = await guard.createSession({ member_id: 'M-1', device_id: 'dev-1' });
    const r = await guard.validateSession({ session_id: s.session_id, current_device_id: 'dev-2' });
    assertEq(r.reason, 'DEVICE_MISMATCH');
  });

  // === createSession / destroySession ===
  await test('T21: createSession returns session with id', async () => {
    const s = await guard.createSession({ member_id: 'M-1' });
    assert(s.session_id.startsWith('SES-'), 'session_id format');
    assertEq(s.member_id, 'M-1');
  });

  await test('T22: destroySession removes session', async () => {
    const s = await guard.createSession({ member_id: 'M-1' });
    const ok = await guard.destroySession({ session_id: s.session_id });
    assertEq(ok, true);
    const after = await guard.validateSession({ session_id: s.session_id });
    assertEq(after.reason, 'INVALID_SESSION');
  });

  await test('T23: touchSession updates last_seen_at', async () => {
    const s = await guard.createSession({ member_id: 'M-1' });
    const before = s.last_seen_at;
    await new Promise((r) => setTimeout(r, 5));
    await guard.touchSession({ session_id: s.session_id });
    const after = guard.sessions.get(s.session_id);
    assert(after.last_seen_at > before, 'last_seen_at should be updated');
  });

  // === withGuard (combined middleware) ===
  await test('T24: withGuard runs handler when all checks pass', async () => {
    const token = TokenValidator.create({ claims: { sub: 'M-1' } });
    const session = await guard.createSession({ member_id: 'M-1', metadata: { tier: 'pro', features: ['lotto'] } });
    const r = await guard.withGuard({
      token, session_id: session.session_id,
      requiredClaims: ['sub'], requiredFeature: 'lotto', minTier: 'pro',
      handler: async () => 'handler-result',
    });
    assertEq(r.ok, true);
    assertEq(r.body.result, 'handler-result');
  });

  await test('T25: withGuard with idempotency_key returns cached result', async () => {
    const token = TokenValidator.create({ claims: { sub: 'M-1' } });
    const session = await guard.createSession({ member_id: 'M-1' });
    let called = 0;
    const handler = async () => { called++; return 'h'; };
    const r1 = await guard.withGuard({ token, session_id: session.session_id, idempotency_key: 'idem-1', handler });
    const r2 = await guard.withGuard({ token, session_id: session.session_id, idempotency_key: 'idem-1', handler });
    assertEq(r1.hit, false);
    assertEq(r1.result.body.idempotent, false);
    assertEq(r1.result.body.result, 'h');
    // r2 = onHit result = top-level { ok, status, body }
    assertEq(r2.ok, true);
    assertEq(r2.status, 200);
    assertEq(r2.body.idempotent, true);
    assertEq(called, 1);
  });

  await test('T26: withGuard rejects when feature missing', async () => {
    const token = TokenValidator.create({ claims: { sub: 'M-1' } });
    const session = await guard.createSession({ member_id: 'M-1', metadata: { tier: 'free', features: [] } });
    const r = await guard.withGuard({
      token, session_id: session.session_id, requiredFeature: 'lotto', handler: async () => 'x',
    });
    assertEq(r.ok, false);
    assertEq(r.reason, 'REQUIRES_FEATURE_LOTTO');
  });

  await test('T27: withGuard rejects when tier too low', async () => {
    const token = TokenValidator.create({ claims: { sub: 'M-1' } });
    const session = await guard.createSession({ member_id: 'M-1', metadata: { tier: 'free', features: [] } });
    const r = await guard.withGuard({
      token, session_id: session.session_id, minTier: 'pro', handler: async () => 'x',
    });
    assertEq(r.reason, 'REQUIRES_TIER_PRO');
  });

  await test('T28: getStats counts sessions and idempotency keys', async () => {
    const s = await guard.createSession({ member_id: 'M-1' });
    await guard.withIdempotency({ key: 'stats-1', onMiss: async () => 'x' });
    const stats = guard.getStats();
    assert(stats.active_sessions >= 1);
    assert(stats.active_idempotency_keys >= 1);
    await guard.destroySession({ session_id: s.session_id });
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
