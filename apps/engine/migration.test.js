// Unit Tests for Migration Engine
const { MigrationEngine } = require('./migration.js');
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

class MockLegacyDB {
  constructor() { this.mappings = new Map(); this.migratedFlags = new Map(); }

  async storeMapping(mapping) { this.mappings.set(mapping.legacy_user_id, mapping); }
  async getMapping(id) { return this.mappings.get(id) || null; }
  async markMigrated(id) { this.migratedFlags.set(id, true); }
  async getAllLegacyUsers() { return []; }
}

class MockAudit { constructor(){this.records=[];} async record(d){this.records.push(d);} }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

async function main() {
  console.log('🧪 ========== Migration Engine Tests ==========\n');

  await test('Migrate legacy user (phone-based) → new system (UUID)', async () => {
    const db = new MockDB();
    const legacy = new MockLegacyDB();
    const audit = new MockAudit();
    const id = new IdentityService({ db, auditLog: audit });
    const engine = new MigrationEngine({ identityService: id, legacyDB: legacy, auditLog: audit });

    const result = await engine.migrateLegacyUser({
      legacy_user_id: 'legacy_001',
      phone_hash: 'h_phone_001',
      phone_last4: '1234',
      display_name: 'Legacy User 1',
      created_at: '2025-01-01'
    });

    assert.strictEqual(result.status, 'MIGRATED');
    assert.ok(result.member_id.startsWith('usr_'));
    assert.strictEqual(result.backward_compat, true);
  });

  await test('Idempotency: same legacy user migrated twice returns same member_id', async () => {
    const db = new MockDB();
    const legacy = new MockLegacyDB();
    const id = new IdentityService({ db });
    const engine = new MigrationEngine({ identityService: id, legacyDB: legacy });

    const first = await engine.migrateLegacyUser({
      legacy_user_id: 'legacy_002',
      phone_hash: 'h_phone_002',
      phone_last4: '5678'
    });

    const second = await engine.migrateLegacyUser({
      legacy_user_id: 'legacy_002',
      phone_hash: 'h_phone_002',
      phone_last4: '5678'
    });

    assert.strictEqual(second.status, 'ALREADY_MIGRATED');
    assert.strictEqual(second.member_id, first.member_id);
  });

  await test('Resolve legacy_user_id to new member_id', async () => {
    const db = new MockDB();
    const legacy = new MockLegacyDB();
    const id = new IdentityService({ db });
    const engine = new MigrationEngine({ identityService: id, legacyDB: legacy });

    const { member_id } = await engine.migrateLegacyUser({
      legacy_user_id: 'legacy_003',
      phone_hash: 'h_phone_003',
      phone_last4: '1111'
    });

    const resolved = await engine.resolveLegacyId('legacy_003');
    assert.strictEqual(resolved.member_id, member_id);
    assert.strictEqual(resolved.migrated, true);
  });

  await test('Batch migrate 3 users', async () => {
    const db = new MockDB();
    const legacy = new MockLegacyDB();
    const id = new IdentityService({ db });
    const engine = new MigrationEngine({ identityService: id, legacyDB: legacy });

    const users = [
      { legacy_user_id: 'l_1', phone_hash: 'h_1', phone_last4: '0001' },
      { legacy_user_id: 'l_2', phone_hash: 'h_2', phone_last4: '0002' },
      { legacy_user_id: 'l_3', phone_hash: 'h_3', phone_last4: '0003' }
    ];

    const result = await engine.batchMigrate(users);
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.success, 3);
    assert.strictEqual(result.failed, 0);
  });

  await test('Verify migration: no duplicate phones', async () => {
    const db = new MockDB();
    const legacy = new MockLegacyDB();
    const id = new IdentityService({ db });
    const engine = new MigrationEngine({ identityService: id, legacyDB: legacy });

    await engine.migrateLegacyUser({ legacy_user_id: 'l_a', phone_hash: 'h_100', phone_last4: '0000' });
    await engine.migrateLegacyUser({ legacy_user_id: 'l_b', phone_hash: 'h_200', phone_last4: '0001' });

    const result = await engine.verifyMigration();
    const noDupCheck = result.checks.find(c => c.name === 'No duplicate phone bindings');
    assert.ok(noDupCheck);
    assert.strictEqual(noDupCheck.passed, true);
  });

  console.log(`\n📊 ========== Test Summary ==========`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Coverage: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed > 0) process.exit(1);
  console.log('\n🎉 All tests passed!');
}

main().catch(err => { console.error(err); process.exit(1); });
