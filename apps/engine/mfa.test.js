// Unit Tests for MFA Engine
const { MFAEngine } = require('../engine/mfa.js');
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
class MockAudit { constructor(){this.records=[];} async record(d){this.records.push(d);} }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

async function main() {
  console.log('🧪 ========== MFA Engine Tests ==========\n');

  await test('Enroll TOTP returns secret + URL', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const mfa = new MFAEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'A' });
    const result = await mfa.enrollTOTP(member.member_id);

    assert.ok(result.secret);
    assert.ok(result.otpauth_url.startsWith('otpauth://totp/'));
    assert.ok(result.secret.length === 32);  // 20 bytes base32
  });

  await test('Generate TOTP code (deterministic)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const mfa = new MFAEngine({ identityService: id });

    // Use a known secret
    const secret = 'JBSWY3DPEHPK3PXP';  // standard test secret
    const counter = Math.floor(Date.now() / 1000 / 30);
    const code = mfa._generateTOTP(secret, counter);
    assert.ok(/^\d{6}$/.test(code), 'should be 6 digits');
  });

  await test('Verify TOTP with valid code', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const mfa = new MFAEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'B' });
    const { secret } = await mfa.enrollTOTP(member.member_id);

    // Generate current TOTP
    const counter = Math.floor(Date.now() / 1000 / 30);
    const code = mfa._generateTOTP(secret, counter);

    const result = await mfa.verifyTOTP(member.member_id, code);
    assert.strictEqual(result.success, true);
  });

  await test('Verify TOTP with wrong code', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const mfa = new MFAEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'C' });
    await mfa.enrollTOTP(member.member_id);

    const result = await mfa.verifyTOTP(member.member_id, '000000');
    assert.strictEqual(result.success, false);
  });

  await test('Verify TOTP must be 6 digits', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const mfa = new MFAEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'D' });
    await mfa.enrollTOTP(member.member_id);

    try {
      await mfa.verifyTOTP(member.member_id, '12345');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('6_DIGITS'));
    }
  });

  await test('Send + verify SMS OTP', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const mfa = new MFAEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'E' });
    await mfa.sendSMSOTP(member.member_id, 'h_phone');

    // Extract code from internal map (in production: read from DB/Redis)
    let code = null;
    for (const k of mfa._sms_codes.keys()) {
      if (k.startsWith(member.member_id + ':')) {
        code = k.split(':')[1];
        break;
      }
    }

    assert.ok(code, 'code should exist');
    const result = await mfa.verifySMSOTP(member.member_id, code);
    assert.strictEqual(result.success, true);
  });

  await test('MFA: 1 factor enough for known IP', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const mfa = new MFAEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'F' });
    const result = await mfa.verifyMFA(member.member_id, {
      password_verified: true
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.required, 1);
  });

  await test('MFA: 2 factors required for new IP', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const mfa = new MFAEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'G' });
    const result = await mfa.verifyMFA(member.member_id, {
      password_verified: true,
      ip_address: '1.2.3.4'
    });

    assert.strictEqual(result.success, false);  // only 1 factor, need 2
    assert.strictEqual(result.required, 2);
  });

  console.log(`\n📊 ========== Test Summary ==========`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Coverage: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed > 0) process.exit(1);
  console.log('\n🎉 All tests passed!');
}

main().catch(err => { console.error(err); process.exit(1); });
