// Unit Tests for Phone Binding Engine — RFC-001 Open Question #2
// 1 member มีหลายเบอร์

const { PhoneBindingEngine } = require('../engine/phone-binding.js');
const { IdentityService } = require('../identity-service/member.js');
const assert = require('assert');

class MockDB {
  constructor() { this.members = new Map(); this.phone_bindings = new Map(); this.consents = new Map(); }
}
class MockAudit { constructor(){this.records=[];} async record(d){this.records.push(d);} }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

async function main() {
  console.log('🧪 ========== Phone Binding Engine Tests ==========\n');
  
  await test('Add second phone to member', async () => {
    const db = new MockDB();
    const audit = new MockAudit();
    const id = new IdentityService({ db, auditLog: audit });
    const engine = new PhoneBindingEngine({ identityService: id, auditLog: audit });
    
    const { member } = await id.createMember({ display_name: 'A', phone_hash: 'h_personal', phone_last4: '1111' });
    
    const second = await engine.addPhone(member.member_id, {
      phone_hash: 'h_work',
      phone_last4: '2222',
      is_primary: false
    });
    
    assert.strictEqual(second.is_primary, false);
    
    const phones = await engine.getPhones(member.member_id);
    assert.strictEqual(phones.length, 2);
  });
  
  await test('Max 5 phones per member', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new PhoneBindingEngine({ identityService: id });
    
    const { member } = await id.createMember({ display_name: 'B', phone_hash: 'h_1' });
    for (let i = 2; i <= 5; i++) {
      await engine.addPhone(member.member_id, { phone_hash: `h_${i}`, phone_last4: `000${i}` });
    }
    
    try {
      await engine.addPhone(member.member_id, { phone_hash: 'h_6', phone_last4: '0006' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('MAX_PHONES'));
    }
  });
  
  await test('Change primary phone (demote old)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new PhoneBindingEngine({ identityService: id });
    
    const { member } = await id.createMember({ display_name: 'C', phone_hash: 'h_personal', phone_last4: '1111' });
    await engine.addPhone(member.member_id, { phone_hash: 'h_work', phone_last4: '2222' });
    
    const newPrimary = await engine.changePrimaryPhone(member.member_id, 'h_work');
    assert.strictEqual(newPrimary.is_primary, true);
    
    const phones = await engine.getPhones(member.member_id);
    const old = phones.find(p => p.phone_hash === 'h_personal');
    assert.strictEqual(old.is_primary, false);
  });
  
  await test('Cannot change primary to unbound phone', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new PhoneBindingEngine({ identityService: id });
    
    const { member } = await id.createMember({ display_name: 'D', phone_hash: 'h_1' });
    
    try {
      await engine.changePrimaryPhone(member.member_id, 'h_not_bound');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('NOT_BOUND'));
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
