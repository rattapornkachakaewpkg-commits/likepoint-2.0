// Unit Tests for Device Binding Engine
const { DeviceBindingEngine } = require('../engine/device-binding.js');
const { IdentityService } = require('../identity-service/member.js');
const assert = require('assert');

class MockDB {
  constructor() {
    this.members = new Map();
    this.phone_bindings = new Map();
    this.consents = new Map();
    this.device_bindings = new Map();
  }
}
class MockAudit { constructor() { this.records = []; } async record(d) { this.records.push(d); } }
class MockNotify { constructor() { this.sent = []; } async send(uid, msg) { this.sent.push({ uid, msg }); } }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

async function main() {
  console.log('🧪 ========== Device Binding Tests ==========\n');

  await test('Register first device (no notify)', async () => {
    const db = new MockDB();
    const audit = new MockAudit();
    const notify = new MockNotify();
    const id = new IdentityService({ db, auditLog: audit });
    const engine = new DeviceBindingEngine({ identityService: id, notificationService: notify, auditLog: audit });

    const { member } = await id.createMember({ display_name: 'A' });
    const device = await engine.registerDevice({
      member_id: member.member_id,
      device_fingerprint: 'fp_001',
      platform: 'ios',
      app_version: '1.0.0',
      ip_address: '1.2.3.4'
    });

    assert.strictEqual(device.status, 'ACTIVE');
    assert.strictEqual(notify.sent.length, 0);  // first device
  });

  await test('Register second device (notify)', async () => {
    const db = new MockDB();
    const audit = new MockAudit();
    const notify = new MockNotify();
    const id = new IdentityService({ db, auditLog: audit });
    const engine = new DeviceBindingEngine({ identityService: id, notificationService: notify, auditLog: audit });

    const { member } = await id.createMember({ display_name: 'B' });
    await engine.registerDevice({ member_id: member.member_id, device_fingerprint: 'fp_a', platform: 'ios', ip_address: '1.1.1.1' });
    const second = await engine.registerDevice({ member_id: member.member_id, device_fingerprint: 'fp_b', platform: 'android', ip_address: '2.2.2.2' });

    assert.strictEqual(second.status, 'PENDING_VERIFICATION');
    assert.strictEqual(notify.sent.length, 1);
  });

  await test('Max 10 devices per member', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new DeviceBindingEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'C' });
    for (let i = 1; i <= 10; i++) {
      await engine.registerDevice({ member_id: member.member_id, device_fingerprint: `fp_${i}`, platform: 'web' });
    }

    try {
      await engine.registerDevice({ member_id: member.member_id, device_fingerprint: 'fp_11' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('MAX_DEVICES'));
    }
  });

  await test('Verify device', async () => {
    const db = new MockDB();
    const audit = new MockAudit();
    const id = new IdentityService({ db, auditLog: audit });
    const engine = new DeviceBindingEngine({ identityService: id, auditLog: audit });

    const { member } = await id.createMember({ display_name: 'D' });
    await engine.registerDevice({ member_id: member.member_id, device_fingerprint: 'fp_a', platform: 'ios', ip_address: '1.1.1.1' });
    const second = await engine.registerDevice({ member_id: member.member_id, device_fingerprint: 'fp_b', platform: 'android', ip_address: '2.2.2.2' });

    const verified = await engine.verifyDevice(second.device_id);
    assert.strictEqual(verified.status, 'ACTIVE');
  });

  await test('Detect suspicious change (different IP + platform)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new DeviceBindingEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'E' });
    await engine.registerDevice({ member_id: member.member_id, device_fingerprint: 'fp_a', platform: 'ios', ip_address: '1.1.1.1' });

    const suspicious = await engine.detectSuspiciousChange(member.member_id, {
      ip_address: '2.2.2.2',
      platform: 'android'
    });

    assert.strictEqual(suspicious.suspicious, true);
    assert.strictEqual(suspicious.requires_2fa, true);
  });

  await test('Normal change (same platform)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new DeviceBindingEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'F' });
    await engine.registerDevice({ member_id: member.member_id, device_fingerprint: 'fp_a', platform: 'ios', ip_address: '1.1.1.1' });

    const result = await engine.detectSuspiciousChange(member.member_id, {
      ip_address: '1.1.1.1',
      platform: 'ios'
    });

    assert.strictEqual(result.suspicious, false);
  });

  console.log(`\n📊 ========== Test Summary ==========`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Coverage: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed > 0) process.exit(1);
  console.log('\n🎉 All tests passed!');
}

main().catch(err => { console.error(err); process.exit(1); });
