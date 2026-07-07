// Recovery Engine — Tests
const { RecoveryEngine } = require('./recovery-engine.js');

function makeMembers() {
  return {
    _m: { 'M-1': { member_id: 'M-1', phone: '081', email: 'a@x.com', failed_recovery_attempts: 0 } },
    get(id) { return this._m[id]; },
    set(id, v) { this._m[id] = v; },
  };
}
function makeTokens() { return new Map(); }
function makeAudit() { return { _l: [], async log(e) { this._l.push(e); } }; }
function makeBus() { return { _e: [], async publish(t, p) { this._e.push({ t, p }); } }; }
function makeNotif() { return { _n: [], async send(p) { this._n.push(p); return { status: 'sent' }; } }; }

let p = 0, f = 0;
const test = async (name, fn) => { try { await fn(); p++; console.log(`  ✅ ${name}`); } catch (e) { f++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

(async () => {
  const members = makeMembers();
  const tokens = makeTokens();
  const audit = makeAudit();
  const bus = makeBus();
  const notif = makeNotif();
  const eng = new RecoveryEngine({ memberStore: members, tokenStore: tokens, auditEngine: audit, eventBus: bus, notifier: notif });

  // requestOTP
  await test('T01: requestOTP requires fields', async () => {
    try { await eng.requestOTP({}); assert(false); } catch (e) { assertContains(e.message, 'required', 'wrong'); }
  });
  await test('T02: requestOTP rejects invalid method', async () => {
    try { await eng.requestOTP({ member_id: 'M-1', method: 'fax', contact: 'x' }); assert(false); } catch (e) { assertContains(e.message, 'Invalid method', 'wrong'); }
  });
  await test('T03: requestOTP success (phone)', async () => {
    const r = await eng.requestOTP({ member_id: 'M-1', method: 'phone', contact: '0812345678' });
    assert(r.request_id);
    assertContains(r.message, 'phone');
    assert(notif._n.length > 0, 'notification sent');
  });
  await test('T04: requestOTP success (email)', async () => {
    const r = await eng.requestOTP({ member_id: 'M-1', method: 'email', contact: 'a@x.com' });
    assert(r.request_id);
  });

  // verifyOTP
  await test('T05: verifyOTP rejects wrong OTP', async () => {
    const r1 = await eng.requestOTP({ member_id: 'M-1', method: 'phone', contact: '081' });
    try { await eng.verifyOTP({ request_id: r1.request_id, otp: 'wrong' }); assert(false); } catch (e) { assertContains(e.message, 'Invalid', 'wrong'); }
  });
  await test('T06: verifyOTP tracks failed attempts', async () => {
    members.set('M-1', { member_id: 'M-1', phone: '081', email: 'a@x.com', failed_recovery_attempts: 0 });
    const r1 = await eng.requestOTP({ member_id: 'M-1', method: 'phone', contact: '081' });
    try { await eng.verifyOTP({ request_id: r1.request_id, otp: 'wrong' }); } catch (e) {}
    assertEq(members.get('M-1').failed_recovery_attempts, 1);
  });
  await test('T07: verifyOTP locks after 5 failed attempts', async () => {
    members.set('M-1', { member_id: 'M-1', failed_recovery_attempts: 0 });
    for (let i = 0; i < 5; i++) {
      const r1 = await eng.requestOTP({ member_id: 'M-1', method: 'phone', contact: '081' });
      try { await eng.verifyOTP({ request_id: r1.request_id, otp: 'wrong' }); } catch (e) {}
    }
    assert(members.get('M-1').locked_until, 'should be locked');
  });
  await test('T08: locked member cannot request OTP', async () => {
    try { await eng.requestOTP({ member_id: 'M-1', method: 'phone', contact: '081' }); assert(false); } catch (e) { assertContains(e.message, 'Locked', 'wrong'); }
  });
  await test('T09: verifyOTP success resets attempts', async () => {
    members.set('M-1', { member_id: 'M-1', phone: '081', email: 'a@x.com', failed_recovery_attempts: 3, locked_until: null });
    const r1 = await eng.requestOTP({ member_id: 'M-1', method: 'phone', contact: '081' });
    // Get OTP from notification
    const lastNotif = notif._n[notif._n.length - 1];
    const otp = lastNotif.variables.otp;
    const r2 = await eng.verifyOTP({ request_id: r1.request_id, otp });
    assertEq(r2.verified, true);
    assertEq(members.get('M-1').failed_recovery_attempts, 0);
  });
  await test('T10: verifyOTP rejects already verified', async () => {
    members.set('M-1', { member_id: 'M-1', phone: '081', failed_recovery_attempts: 0 });
    const r1 = await eng.requestOTP({ member_id: 'M-1', method: 'phone', contact: '081' });
    const otp = notif._n[notif._n.length - 1].variables.otp;
    await eng.verifyOTP({ request_id: r1.request_id, otp });
    try { await eng.verifyOTP({ request_id: r1.request_id, otp }); assert(false); } catch (e) { assertContains(e.message, 'Already', 'wrong'); }
  });

  // security questions
  await test('T11: setSecurityQuestions requires at least 2', async () => {
    try { await eng.setSecurityQuestions({ member_id: 'M-1', questions: [{ question: 'q1', answer: 'a' }] }); assert(false); } catch (e) { assertContains(e.message, '2', 'wrong'); }
  });
  await test('T12: setSecurityQuestions + verifySecurityQuestion', async () => {
    members.set('M-2', { member_id: 'M-2' });
    await eng.setSecurityQuestions({ member_id: 'M-2', questions: [
      { question: 'city', answer: 'Bangkok' },
      { question: 'color', answer: 'Blue' },
    ] });
    const r = await eng.verifySecurityQuestion({ member_id: 'M-2', answers: [
      { question: 'city', answer: 'Bangkok' },
      { question: 'color', answer: 'Blue' },
    ] });
    assertEq(r.verified, true);
    assert(r.recovery_token);
  });
  await test('T13: verifySecurityQuestion rejects <2 correct', async () => {
    members.set('M-3', { member_id: 'M-3', security_questions: [{ question: 'q', answer_hash: 'x' }, { question: 'r', answer_hash: 'y' }] });
    try { await eng.verifySecurityQuestion({ member_id: 'M-3', answers: [{ question: 'q', answer: 'wrong' }] }); assert(false); } catch (e) { assertContains(e.message, '0', 'wrong'); }
  });

  // resetPassword
  await test('T14: resetPassword requires valid recovery token', async () => {
    try { await eng.resetPassword({ recovery_token: 'fake', new_password_hash: '12345678' }); assert(false); } catch (e) { assertContains(e.message, 'Invalid', 'wrong'); }
  });
  await test('T15: resetPassword requires min 8 chars', async () => {
    members.set('M-4', { member_id: 'M-4' });
    const r = await eng.requestOTP({ member_id: 'M-4', method: 'phone', contact: '081' });
    const otp = notif._n[notif._n.length - 1].variables.otp;
    const v = await eng.verifyOTP({ request_id: r.request_id, otp });
    try { await eng.resetPassword({ recovery_token: v.recovery_token, new_password_hash: 'short' }); assert(false); } catch (e) { assertContains(e.message, 'short', 'wrong'); }
  });
  await test('T16: resetPassword success', async () => {
    members.set('M-5', { member_id: 'M-5', phone: '081' });
    const r = await eng.requestOTP({ member_id: 'M-5', method: 'phone', contact: '081' });
    const otp = notif._n[notif._n.length - 1].variables.otp;
    const v = await eng.verifyOTP({ request_id: r.request_id, otp });
    const reset = await eng.resetPassword({ recovery_token: v.recovery_token, new_password_hash: 'newpassword123' });
    assertEq(reset.sessions_invalidated, true);
    assert(members.get('M-5').password_reset_at);
  });
  await test('T17: resetPassword invalidates recovery token (single-use)', async () => {
    members.set('M-6', { member_id: 'M-6', phone: '081' });
    const r = await eng.requestOTP({ member_id: 'M-6', method: 'phone', contact: '081' });
    const otp = notif._n[notif._n.length - 1].variables.otp;
    const v = await eng.verifyOTP({ request_id: r.request_id, otp });
    await eng.resetPassword({ recovery_token: v.recovery_token, new_password_hash: 'newpassword123' });
    try { await eng.resetPassword({ recovery_token: v.recovery_token, new_password_hash: 'another' }); assert(false); } catch (e) { assertContains(e.message, 'Invalid', 'wrong'); }
  });

  // emailLink
  await test('T18: requestEmailLink sends link via email', async () => {
    members.set('M-7', { member_id: 'M-7', email: 'b@y.com' });
    const r = await eng.requestEmailLink({ member_id: 'M-7', email: 'b@y.com' });
    assertEq(r.link_sent, true);
  });

  // lockAccount
  await test('T19: lockAccount sets locked_until', async () => {
    members.set('M-8', { member_id: 'M-8' });
    const r = await eng.lockAccount({ member_id: 'M-8', reason: 'too_many_failed_logins' });
    assert(r.locked_until);
    assert(audit._l.some((l) => l.event_type === 'ACCOUNT_LOCKED'));
  });

  // getRecoveryStatus
  await test('T20: getRecoveryStatus returns lockout info', async () => {
    members.set('M-9', { member_id: 'M-9', security_questions: [{}, {}], failed_recovery_attempts: 2 });
    const r = await eng.getRecoveryStatus({ member_id: 'M-9' });
    assertEq(r.failed_attempts, 2);
    assertEq(r.has_security_questions, true);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${p}/${p + f} passed${f ? `, ${f} failed` : ''}`);
  process.exit(f > 0 ? 1 : 0);
})();
