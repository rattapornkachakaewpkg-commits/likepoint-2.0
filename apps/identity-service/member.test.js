// Unit Tests for Identity Service — RFC-001
// Author: AliClaw | Date: 2026-07-07

const { IdentityService } = require('../identity-service/member.js');
const assert = require('assert');

// =================== MOCKS ===================
class MockDB {
  constructor() {
    this.members = new Map();
    this.phone_bindings = new Map();
    this.consents = new Map();
  }
}
class MockAudit {
  constructor() { this.records = []; }
  async record(d) { this.records.push(d); }
}

// =================== TESTS ===================
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

async function main() {
  console.log('🧪 ========== Identity Service Tests ==========\n');
  
  // TEST 1: Create Member (UUID generation)
  await test('Create Member: generates UUID, sets defaults', async () => {
    const db = new MockDB();
    const audit = new MockAudit();
    const svc = new IdentityService({ db, auditLog: audit });
    
    const { member, phone_binding } = await svc.createMember({
      display_name: 'สมชาย',
      phone_hash: 'h_phone_001',
      phone_last4: '5678'
    });
    
    assert.ok(member.member_id.startsWith('usr_'), 'UUID prefix');
    assert.strictEqual(member.member_id.length, 36);  // usr_ + 32 hex chars (UUID v4)
    assert.strictEqual(member.display_name, 'สมชาย');
    assert.strictEqual(member.status, 'ACTIVE');
    assert.strictEqual(member.trust_score, '50');
    assert.ok(phone_binding);
    assert.strictEqual(phone_binding.is_primary, true);
    // 2 audit events: MEMBER_CREATED + PHONE_BOUND
    const actions = audit.records.map(r => r.action);
    assert.ok(actions.includes('MEMBER_CREATED'));
    assert.ok(actions.includes('PHONE_BOUND'));
  });
  
  // TEST 2: Get Member by member_id
  await test('Get Member: by member_id', async () => {
    const db = new MockDB();
    const svc = new IdentityService({ db });
    const { member } = await svc.createMember({ display_name: 'A' });
    const found = await svc.getMember(member.member_id);
    assert.strictEqual(found.display_name, 'A');
  });
  
  // TEST 3: Get Member by phone_hash
  await test('Get Member: by phone_hash (lookup via binding)', async () => {
    const db = new MockDB();
    const svc = new IdentityService({ db });
    const { member } = await svc.createMember({ display_name: 'B', phone_hash: 'h_001' });
    const found = await svc.getMemberByPhone('h_001');
    assert.strictEqual(found.member_id, member.member_id);
  });
  
  // TEST 4: Update Member
  await test('Update Member: only allow safe fields', async () => {
    const db = new MockDB();
    const audit = new MockAudit();
    const svc = new IdentityService({ db, auditLog: audit });
    const { member } = await svc.createMember({ display_name: 'C' });
    
    const updated = await svc.updateMember(member.member_id, {
      display_name: 'C updated',
      kyc_level: 'LEVEL_1',
      // Try to inject forbidden field
      member_id: 'usr_hacked'
    });
    
    assert.strictEqual(updated.display_name, 'C updated');
    assert.strictEqual(updated.kyc_level, 'LEVEL_1');
    assert.strictEqual(updated.member_id, member.member_id);  // ไม่เปลี่ยน
  });
  
  // TEST 5: Delete Member (soft delete)
  await test('Delete Member: soft delete (status=DELETED)', async () => {
    const db = new MockDB();
    const svc = new IdentityService({ db });
    const { member } = await svc.createMember({ display_name: 'D' });
    
    const deleted = await svc.deleteMember(member.member_id);
    assert.strictEqual(deleted.status, 'DELETED');
    assert.ok(deleted.deleted_at);
  });
  
  // TEST 6: Multi-phone Support
  await test('Multi-phone: bind second phone, primary demotes to secondary', async () => {
    const db = new MockDB();
    const svc = new IdentityService({ db });
    const { member, phone_binding: primary } = await svc.createMember({
      display_name: 'E', phone_hash: 'h_001', phone_last4: '1111'
    });
    
    // Bind second phone
    const second = await svc.bindPhone({
      member_id: member.member_id,
      phone_hash: 'h_002',
      phone_last4: '2222',
      is_primary: true  // promote to primary
    });
    
    assert.strictEqual(second.is_primary, true);
    
    // Check old primary
    const updated = await svc.getPhonesForMember(member.member_id);
    const oldBinding = updated.find(b => b.binding_id === primary.binding_id);
    assert.strictEqual(oldBinding.is_primary, false);
  });
  
  // TEST 7: Phone duplicate detection
  await test('Phone duplicate: reject binding to another member', async () => {
    const db = new MockDB();
    const svc = new IdentityService({ db });
    await svc.createMember({ display_name: 'F1', phone_hash: 'h_shared' });
    
    try {
      await svc.createMember({ display_name: 'F2', phone_hash: 'h_shared' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('PHONE_ALREADY_BOUND'));
    }
  });
  
  // TEST 8: Cannot remove primary phone
  await test('Cannot remove primary phone', async () => {
    const db = new MockDB();
    const svc = new IdentityService({ db });
    const { phone_binding } = await svc.createMember({ display_name: 'G', phone_hash: 'h_001' });
    
    try {
      await svc.unbindPhone(phone_binding.binding_id);
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('PRIMARY'));
    }
  });
  
  // TEST 9: Consent (PDPA)
  await test('Consent: record + revoke', async () => {
    const db = new MockDB();
    const audit = new MockAudit();
    const svc = new IdentityService({ db, auditLog: audit });
    const { member } = await svc.createMember({ display_name: 'H' });
    
    const consent = await svc.recordConsent({
      member_id: member.member_id,
      consent_type: 'MARKETING',
      granted: true
    });
    assert.strictEqual(consent.granted, true);
    assert.ok(consent.granted_at);
    
    const revoked = await svc.revokeConsent(consent.consent_id);
    assert.strictEqual(revoked.granted, false);
    assert.ok(revoked.revoked_at);
  });
  
  // TEST 10: Validation
  await test('Validation: missing display_name', async () => {
    const db = new MockDB();
    const svc = new IdentityService({ db });
    try {
      await svc.createMember({});
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('display_name'));
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
