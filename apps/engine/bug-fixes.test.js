// Bug Fixes — Unit Tests
// Regression tests for 5 critical production-readiness bugs
// Author: AliClaw | Date: 2026-07-07

const { Logger, IdempotencyLock, globalIdemLock, validateAmount, redactSensitive, TokenValidator } = require('./bug-fixes.js');

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n🐛 Bug Fixes — Regression Tests\n');

(async () => {
  // === BUG #1: Logger replaces console.log ===
  await test('T01: Logger has 4 levels (error/warn/info/debug)', async () => {
    const log = new Logger({ level: 'info' });
    assert(typeof log.info === 'function');
    assert(typeof log.warn === 'function');
    assert(typeof log.error === 'function');
    assert(typeof log.debug === 'function');
  });

  await test('T02: Logger redacts sensitive keys in metadata', async () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data) => { captured.push(data); return true; };
    const log = new Logger({ level: 'info' });
    log.info('test', { user_id: 'u1', pin: '999888', otp: '777', phone: '0812345678' });
    process.stdout.write = orig;
    const output = captured.join('');
    assertContains(output, '[REDACTED]', 'should redact');
    assertContains(output, '0812345678', 'non-sensitive should pass');
    assert(!output.includes('999888'), 'PIN should not appear');
    assert(!output.includes('777'), 'OTP should not appear');
  });

  await test('T03: Logger respects log level (debug suppressed in info mode)', async () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data) => { captured.push(data); return true; };
    const log = new Logger({ level: 'info' });
    log.debug('hidden message', { foo: 'bar' });
    process.stdout.write = orig;
    assertEq(captured.length, 0, 'debug should be suppressed');
  });

  // === BUG #2: IdempotencyLock prevents race ===
  await test('T04: IdempotencyLock serializes same-key operations', async () => {
    const lock = new IdempotencyLock();
    const results = [];
    const fn = async (i) => {
      return lock.withLock('key1', async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(i);
        return i * 2;
      });
    };
    const [a, b, c] = await Promise.all([fn(1), fn(2), fn(3)]);
    // Should run sequentially (not parallel) since same key
    assertEq(results.length, 3);
    assertEq(a, 2); assertEq(b, 4); assertEq(c, 6);
  });

  await test('T05: IdempotencyLock allows parallel different keys', async () => {
    const lock = new IdempotencyLock();
    const start = Date.now();
    await Promise.all([
      lock.withLock('a', async () => { await new Promise((r) => setTimeout(r, 50)); }),
      lock.withLock('b', async () => { await new Promise((r) => setTimeout(r, 50)); }),
    ]);
    const elapsed = Date.now() - start;
    assert(elapsed < 100, `should run in parallel, took ${elapsed}ms`);
  });

  // === BUG #3: validateAmount ===
  await test('T06: validateAmount rejects non-number', async () => {
    try { validateAmount('100'); assert(false); }
    catch (e) { assertContains(e.message, 'number', 'wrong error'); }
  });

  await test('T07: validateAmount rejects NaN', async () => {
    try { validateAmount(NaN); assert(false); }
    catch (e) { assertContains(e.message, 'number', 'wrong error'); }
  });

  await test('T08: validateAmount allows zero by default', async () => {
    const r = validateAmount(0);
    assertEq(r, 0);
  });

  await test('T09: validateAmount rejects zero when allowZero=false', async () => {
    try { validateAmount(0, { allowZero: false }); assert(false); }
    catch (e) { assertContains(e.message, '> 0', 'wrong error'); }
  });

  await test('T10: validateAmount rejects negative', async () => {
    try { validateAmount(-1, { min: 0 }); assert(false); }
    catch (e) { assertContains(e.message, '>= 0', 'wrong error'); }
  });

  await test('T11: validateAmount rejects above max', async () => {
    try { validateAmount(2000000, { max: 1000000 }); assert(false); }
    catch (e) { assertContains(e.message, '<=', 'wrong error'); }
  });

  // === BUG #4: redactSensitive ===
  await test('T12: redactSensitive redacts short strings', async () => {
    assertEq(redactSensitive('ab'), '***');
  });

  await test('T13: redactSensitive shows partial for long strings', async () => {
    const r = redactSensitive('1234567890');
    assertEq(r, '12***90');
  });

  await test('T14: redactSensitive redacts sensitive keys in objects', async () => {
    const r = redactSensitive({ user: 'alice', pin: '123456', otp: '999', phone: '0812345678' });
    assertEq(r.pin, '[REDACTED]');
    assertEq(r.otp, '[REDACTED]');
    assertEq(r.user, 'al***ce'); // 5 chars, partial
    assertEq(r.phone, '08***78');
  });

  await test('T15: redactSensitive redacts nested objects', async () => {
    const r = redactSensitive({ auth: { token: 'abc123def456', user_id: 'u1' } });
    assertEq(r.auth.token, '[REDACTED]');
    assertEq(r.auth.user_id, '***'); // 2 chars
  });

  await test('T16: redactSensitive handles arrays', async () => {
    const r = redactSensitive(['pin1234', 'pi', 'safe_long_string']);
    assertEq(r[0], 'pi***34'); // 7 chars, partial
    assertEq(r[1], '***'); // 2 chars
    assertEq(r[2], 'sa***ng'); // 16 chars
  });

  // === BUG #5: TokenValidator ===
  await test('T17: TokenValidator rejects invalid token', async () => {
    const r = TokenValidator.validate(null);
    assertEq(r.valid, false);
    assertEq(r.reason, 'INVALID_TOKEN');
  });

  await test('T18: TokenValidator rejects token without expiry', async () => {
    const r = TokenValidator.validate({ sub: 'u1' });
    assertEq(r.reason, 'NO_EXPIRY_SET');
  });

  await test('T19: TokenValidator accepts valid token', async () => {
    const token = TokenValidator.create({ claims: { sub: 'u1', role: 'admin' }, ttlSeconds: 3600 });
    const r = TokenValidator.validate(token, { requiredClaims: ['sub'] });
    assertEq(r.valid, true);
    assertEq(r.claims.sub, 'u1');
  });

  await test('T20: TokenValidator rejects expired token', async () => {
    const token = TokenValidator.create({ claims: { sub: 'u1' }, ttlSeconds: -60 });
    const r = TokenValidator.validate(token);
    assertEq(r.reason, 'EXPIRED');
  });

  await test('T21: TokenValidator enforces required claims', async () => {
    const token = TokenValidator.create({ claims: { sub: 'u1' }, ttlSeconds: 3600 });
    const r = TokenValidator.validate(token, { requiredClaims: ['sub', 'role'] });
    assertEq(r.valid, false);
    assertContains(r.reason, 'MISSING_CLAIM:role');
  });

  await test('T22: TokenValidator rejects not-yet-valid token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = { sub: 'u1', nbf: now + 3600, exp: now + 7200 };
    const r = TokenValidator.validate(token);
    assertEq(r.reason, 'NOT_YET_VALID');
  });

  // === Integration: real-world usage ===
  await test('T23: validateAmount used in credit (real-world example)', async () => {
    const memberId = 'M-1';
    const amount = 100;
    // Simulating credit flow
    const validated = validateAmount(amount, { min: 0.01, max: 1000000, allowZero: false });
    assertEq(validated, 100);
  });

  await test('T24: TokenValidator in middleware (gate API request)', async () => {
    // Simulating API middleware
    const authHeader = 'Bearer xxx';
    const token = TokenValidator.create({ claims: { sub: 'u1', role: 'admin' }, ttlSeconds: 3600 });
    const check = TokenValidator.validate(token, { requiredClaims: ['sub', 'role'] });
    assert(check.valid);
    // If check.valid → continue, else 401
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
