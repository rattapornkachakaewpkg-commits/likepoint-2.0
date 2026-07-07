// Combined tests for KYC, Recovery, Notification
const { KYCEngine } = require('./kyc.js');
const { AccountRecoveryEngine } = require('./recovery-flow.js');
const { NotificationService } = require('./notification.js');
const { IdentityService } = require('../identity-service/member.js');
const assert = require('assert');

class MockDB {
  constructor() { this.members = new Map(); this.phone_bindings = new Map(); this.consents = new Map(); this.device_bindings = new Map(); }
}
class MockAudit { constructor(){this.records=[];} async record(d){this.records.push(d);} }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

async function main() {
  console.log('🧪 ========== OQ-9,10,11 Tests ==========\n');

  // ===== OQ-9: KYC =====
  await test('KYC: Upgrade to LEVEL_1 (auto-approve)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const kyc = new KYCEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'A' });
    const result = await kyc.upgradeKYC(member.member_id, { target_level: 'LEVEL_1' });

    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.level, 'LEVEL_1');
  });

  await test('KYC: LEVEL_2 requires documents', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const kyc = new KYCEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'B' });

    try {
      await kyc.upgradeKYC(member.member_id, { target_level: 'LEVEL_2' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('LEVEL_2_REQUIRES'));
    }
  });

  await test('KYC: Check gate — LEVEL_1 can do LEVEL_0+1 only', async () => {
    const kyc = new KYCEngine({ identityService: { db: new MockDB() } });
    const result = kyc.checkKYCGate({ kyc_level: 'LEVEL_1' }, 'LEVEL_2');
    assert.strictEqual(result.allowed, false);
  });

  // ===== OQ-10: Recovery =====
  await test('Recovery: Start flow by phone_hash', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const rec = new AccountRecoveryEngine({ identityService: id });

    await id.createMember({ display_name: 'A', phone_hash: 'h_phone' });
    const result = await rec.startRecovery({ phone_hash: 'h_phone' });

    assert.ok(result.recovery_id.startsWith('rec_'));
    assert.ok(result.required_steps.length > 0);
  });

  await test('Recovery: Complete phone step with OTP', async () => {
    const rec = new AccountRecoveryEngine({ identityService: { db: new MockDB() } });
    const result = await rec.completeStep('rec_001', 'VERIFY_PHONE', { otp_code: '123456' });
    assert.strictEqual(result.success, true);
  });

  // ===== OQ-11: Notification =====
  await test('Notification: Send SMS', async () => {
    const notif = new NotificationService();
    const result = await notif.send('usr_001', { type: 'TEST', channel: 'SMS', message: 'Hello' });
    assert.strictEqual(result.status, 'SENT');
    assert.strictEqual(notif.sent.length, 1);
  });

  await test('Notification: Send BCT_DISTRIBUTED template', async () => {
    const notif = new NotificationService();
    const result = await notif.sendTemplated('usr_001', 'BCT_DISTRIBUTED', { amount: 1000, channel: 'SMS' });
    assert.ok(result.message.includes('1000'));
  });

  await test('Notification: Reject invalid channel', async () => {
    const notif = new NotificationService();
    try {
      await notif.send('usr_001', { type: 'TEST', channel: 'FAX', message: 'Hi' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('INVALID_CHANNEL'));
    }
  });

  console.log(`\n📊 ========== Test Summary ==========`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Coverage: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed > 0) process.exit(1);
  console.log('\n🎉 All tests passed!');
}

main().catch(err => { console.error(err); process.exit(1); });
