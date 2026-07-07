// Unit Tests for Identity Resolution Engine
const { IdentityResolutionEngine } = require('../engine/identity-resolution.js');
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
  console.log('🧪 ========== Identity Resolution Tests ==========\n');

  await test('Same phone_hash → high confidence match', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new IdentityResolutionEngine({ identityService: id });

    // A มี phone_hash 'h_shared'
    const { member: a } = await id.createMember({ display_name: 'A', phone_hash: 'h_shared', phone_last4: '1234' });
    // B ไม่มี phone_hash แต่ลองด้วย phone_hash 'h_shared'
    const { member: b } = await id.createMember({ display_name: 'B' });

    const matches = await engine.findDuplicates({ member_id: b.member_id, phone_hash: 'h_shared' });

    assert.ok(matches.length > 0, 'should have matches');
    const aMatch = matches.find(m => m.member_id === a.member_id);
    assert.ok(aMatch, 'should match A');
    assert.strictEqual(aMatch.confidence, 0.95);
  });

  await test('Same device → match with 0.85 confidence', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new IdentityResolutionEngine({ identityService: id });

    const { member: a } = await id.createMember({ display_name: 'A' });
    const { member: b } = await id.createMember({ display_name: 'B' });

    // A has device 'fp_1', B tries to register same device
    const dev = {
      device_id: 'd_1',
      member_id: a.member_id,
      device_fingerprint: 'fp_1',
      platform: 'ios',
      last_seen_at: new Date().toISOString()
    };
    db.device_bindings.set(dev.device_id, dev);

    const matches = await engine.findDuplicates({ member_id: b.member_id, device_fingerprint: 'fp_1' });
    const aMatch = matches.find(m => m.member_id === a.member_id);
    assert.ok(aMatch);
    assert.strictEqual(aMatch.confidence, 0.85);
  });

  await test('Multiple signals boost confidence', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new IdentityResolutionEngine({ identityService: id });

    const { member: a } = await id.createMember({ display_name: 'A' });
    const { member: b } = await id.createMember({ display_name: 'B' });

    // A has same phone + same device as B
    db.phone_bindings.set('pb_1', {
      binding_id: 'pb_1', member_id: a.member_id, phone_hash: 'h_1', is_primary: true, status: 'VERIFIED'
    });
    db.device_bindings.set('d_1', {
      device_id: 'd_1', member_id: a.member_id, device_fingerprint: 'fp_1', platform: 'ios', last_seen_at: new Date().toISOString()
    });

    const matches = await engine.findDuplicates({
      member_id: b.member_id,
      phone_hash: 'h_1',
      device_fingerprint: 'fp_1'
    });

    const aMatch = matches.find(m => m.member_id === a.member_id);
    assert.ok(aMatch);
    assert.ok(aMatch.confidence > 0.95);  // multiple signals boost
  });

  await test('No matches when signals are different', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new IdentityResolutionEngine({ identityService: id });

    await id.createMember({ display_name: 'A', phone_hash: 'h_A' });
    const { member: b } = await id.createMember({ display_name: 'B' });

    const matches = await engine.findDuplicates({
      member_id: b.member_id,
      phone_hash: 'h_B',
      device_fingerprint: 'fp_B'
    });
    assert.strictEqual(matches.length, 0);
  });

  await test('classifyAction: AUTO_MERGE for > 0.95', async () => {
    const engine = new IdentityResolutionEngine({ identityService: { db: new MockDB() } });
    const result = engine.classifyAction(0.97);
    assert.strictEqual(result.action, 'AUTO_MERGE');
  });

  await test('classifyAction: MANUAL_REVIEW for 0.80-0.95', async () => {
    const engine = new IdentityResolutionEngine({ identityService: { db: new MockDB() } });
    const result = engine.classifyAction(0.85);
    assert.strictEqual(result.action, 'MANUAL_REVIEW');
  });

  await test('classifyAction: REJECT for < 0.80', async () => {
    const engine = new IdentityResolutionEngine({ identityService: { db: new MockDB() } });
    const result = engine.classifyAction(0.50);
    assert.strictEqual(result.action, 'REJECT');
  });

  await test('Name similarity: identical → 1.0', async () => {
    const engine = new IdentityResolutionEngine({ identityService: { db: new MockDB() } });
    const sim = engine._nameSimilarity('สมชาย', 'สมชาย');
    assert.strictEqual(sim, 1);
  });

  await test('Name similarity: very different → < 0.5', async () => {
    const engine = new IdentityResolutionEngine({ identityService: { db: new MockDB() } });
    const sim = engine._nameSimilarity('สมชาย', 'พรเทพ');
    assert.ok(sim < 0.5);
  });

  console.log(`\n📊 ========== Test Summary ==========`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Coverage: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed > 0) process.exit(1);
  console.log('\n🎉 All tests passed!');
}

main().catch(err => { console.error(err); process.exit(1); });
