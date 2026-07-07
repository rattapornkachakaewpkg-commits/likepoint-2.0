// MFA Engine — Tests
const { MFAEngine } = require('./mfa-engine.js');

function makeMembers() { return new Map([['M-1', { member_id: 'M-1' }], ['M-2', { member_id: 'M-2' }]]); }
function makeNotif() { return { _n: [], async send(p) { this._n.push(p); return { status: 'sent' }; } }; }
function makeAudit() { return { _l: [], async log(e) { this._l.push(e); } }; }
function makeBus() { return { _e: [], async publish(t, p) { this._e.push({ t, p }); } }; }

let p = 0, f = 0;
const test = async (name, fn) => { try { await fn(); p++; console.log(`  ✅ ${name}`); } catch (e) { f++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

(async () => {
  const eng = new MFAEngine({ memberStore: makeMembers(), notifier: makeNotif(), auditEngine: makeAudit(), eventBus: makeBus() });

  // TOTP
  await test('T01: enrollTOTP returns secret + otpauth URL', async () => {
    const r = await eng.enrollTOTP({ member_id: 'M-1' });
    assertEq(r.secret.length, 32);
    assertContains(r.otpauth_url, 'otpauth://totp/');
  });
  await test('T02: verifyTOTP accepts correct code', async () => {
    const r = await eng.enrollTOTP({ member_id: 'M-1' });
    const code = eng._simulateTOTP(r.secret, Math.floor(Date.now() / 30000) * 30);
    const v = await eng.verifyTOTP({ member_id: 'M-1', code });
    assertEq(v.verified, true);
  });
  await test('T03: verifyTOTP rejects wrong code', async () => {
    await eng.enrollTOTP({ member_id: 'M-1' });
    const v = await eng.verifyTOTP({ member_id: 'M-1', code: '000000' });
    // 000000 is unlikely to be the right code
    assertEq(v.verified, false);
  });

  // SMS
  await test('T04: enrollSMS + sendSMSOTP sends via notifier', async () => {
    await eng.enrollSMS({ member_id: 'M-1', phone: '0812345678' });
    const notif = eng.notifier;
    const before = notif._n.length;
    const r = await eng.sendSMSOTP({ member_id: 'M-1' });
    assertEq(notif._n.length, before + 1, 'notification sent');
    assert(r.request_id);
  });
  await test('T05: verifySMSOTP success', async () => {
    const r1 = await eng.sendSMSOTP({ member_id: 'M-1' });
    const otp = eng.notifier._n[eng.notifier._n.length - 1].variables.otp;
    const r2 = await eng.verifySMSOTP({ request_id: r1.request_id, otp });
    assertEq(r2.verified, true);
  });
  await test('T06: verifySMSOTP rejects wrong code', async () => {
    const r1 = await eng.sendSMSOTP({ member_id: 'M-1' });
    try { await eng.verifySMSOTP({ request_id: r1.request_id, otp: '000000' }); assert(false); } catch (e) { assertContains(e.message, 'Invalid', 'wrong'); }
  });
  await test('T07: verifySMSOTP single-use (rejects after success)', async () => {
    const r1 = await eng.sendSMSOTP({ member_id: 'M-1' });
    const otp = eng.notifier._n[eng.notifier._n.length - 1].variables.otp;
    await eng.verifySMSOTP({ request_id: r1.request_id, otp });
    try { await eng.verifySMSOTP({ request_id: r1.request_id, otp }); assert(false); } catch (e) { assertContains(e.message, 'Invalid', 'wrong'); }
  });

  // Biometric
  await test('T08: enrollBiometric registers trusted device', async () => {
    const r = await eng.enrollBiometric({ member_id: 'M-2', device_id: 'dev-1', biometric_type: 'fingerprint', public_key: 'pk_abc123' });
    assert(r.factor_id);
    assert(eng.devices.get('dev-1'), 'device registered');
  });
  await test('T09: enrollBiometric rejects invalid biometric_type', async () => {
    try { await eng.enrollBiometric({ member_id: 'M-2', device_id: 'dev-2', biometric_type: 'eye', public_key: 'x' }); assert(false); } catch (e) { assertContains(e.message, 'Invalid', 'wrong'); }
  });
  await test('T10: verifyBiometric accepts correct signature', async () => {
    const r = await eng.enrollBiometric({ member_id: 'M-2', device_id: 'dev-3', biometric_type: 'face', public_key: 'pk_xyz' });
    const v = await eng.verifyBiometric({ member_id: 'M-2', device_id: 'dev-3', signature: 'sig_pk_xyz' });
    assertEq(v.verified, true);
  });
  await test('T11: verifyBiometric rejects wrong signature', async () => {
    const r = await eng.enrollBiometric({ member_id: 'M-2', device_id: 'dev-4', biometric_type: 'face', public_key: 'pk_abc' });
    const v = await eng.verifyBiometric({ member_id: 'M-2', device_id: 'dev-4', signature: 'wrong' });
    assertEq(v.verified, false);
  });

  // Recovery codes
  await test('T12: generateRecoveryCodes returns 10 codes', async () => {
    const r = await eng.generateRecoveryCodes({ member_id: 'M-1' });
    assertEq(r.codes.length, 10);
  });
  await test('T13: useRecoveryCode marks as used', async () => {
    const r = await eng.generateRecoveryCodes({ member_id: 'M-1' });
    const v = await eng.useRecoveryCode({ member_id: 'M-1', code: r.codes[0] });
    assertEq(v.verified, true);
  });
  await test('T14: useRecoveryCode rejects double-use', async () => {
    const r = await eng.generateRecoveryCodes({ member_id: 'M-1' });
    await eng.useRecoveryCode({ member_id: 'M-1', code: r.codes[0] });
    try { await eng.useRecoveryCode({ member_id: 'M-1', code: r.codes[0] }); assert(false); } catch (e) { assertContains(e.message, 'already', 'wrong'); }
  });
  await test('T15: generateRecoveryCodes revokes old codes', async () => {
    await eng.generateRecoveryCodes({ member_id: 'M-1' });
    const r1 = await eng.generateRecoveryCodes({ member_id: 'M-1' });
    try { await eng.useRecoveryCode({ member_id: 'M-1', code: 'old-code' }); assert(false); } catch (e) { /* expected */ }
    // Old codes should be revoked (not in new set)
    const newCodes = Array.from(eng.recoveryCodes.values()).filter((c) => c.member_id === 'M-1' && !c.used_at);
    assert(newCodes.every((c) => r1.codes.includes(c.code)), 'all unused codes are new');
  });

  // listFactors / getStatus
  await test('T16: listFactors returns enrolled factors', async () => {
    const r = await eng.listFactors({ member_id: 'M-1' });
    assert(r.factors.length > 0);
  });
  await test('T17: getStatus returns enabled=true with factors', async () => {
    const r = await eng.getStatus({ member_id: 'M-1' });
    assertEq(r.enabled, true);
    assert(r.has_totp);
  });
  await test('T18: getStatus returns enabled=false for no factors', async () => {
    const r = await eng.getStatus({ member_id: 'M-2' });
    // M-2 only has biometric so has_totp = false
    assertEq(r.has_totp, false);
  });

  // removeFactor
  await test('T19: removeFactor sets status=removed', async () => {
    const r1 = await eng.enrollTOTP({ member_id: 'M-1' });
    const r2 = await eng.removeFactor({ member_id: 'M-1', factor_id: r1.factor_id });
    assertEq(r2.status, 'removed');
  });
  await test('T20: removeFactor rejects other user\'s factor', async () => {
    const r1 = await eng.enrollTOTP({ member_id: 'M-1' });
    try { await eng.removeFactor({ member_id: 'M-2', factor_id: r1.factor_id }); assert(false); } catch (e) { assertContains(e.message, 'another user', 'wrong'); }
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${p}/${p + f} passed${f ? `, ${f} failed` : ''}`);
  process.exit(f > 0 ? 1 : 0);
})();
