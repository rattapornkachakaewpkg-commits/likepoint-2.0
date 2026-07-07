// Unit Tests for Cross-Tenant Point Transfer
const { CrossTenantPointEngine } = require('./cross-tenant-point.js');
const assert = require('assert');

class MockWalletAPI {
  constructor() { this.balances = new Map(); this.transactions = []; }

  async getBalance(memberId, tenantId) {
    return this.balances.get(`${memberId}:${tenantId}`) || 0;
  }

  async debit({ member_id, tenant_id, amount, transfer_id, reason }) {
    const key = `${member_id}:${tenant_id}`;
    const current = this.balances.get(key) || 0;
    if (current < amount) throw new Error('INSUFFICIENT_BALANCE');
    this.balances.set(key, current - amount);
    this.transactions.push({ type: 'DEBIT', member_id, tenant_id, amount, transfer_id, reason });
  }

  async credit({ member_id, tenant_id, amount, transfer_id, reason }) {
    const key = `${member_id}:${tenant_id}`;
    this.balances.set(key, (this.balances.get(key) || 0) + amount);
    this.transactions.push({ type: 'CREDIT', member_id, tenant_id, amount, transfer_id, reason });
  }
}

class MockTenantAPI {
  constructor() { this.relationships = new Set(); }

  async getRelationship(memberId, tenantId) {
    return this.relationships.has(`${memberId}:${tenantId}`) ? { ok: true } : null;
  }

  addRelationship(memberId, tenantId) {
    this.relationships.add(`${memberId}:${tenantId}`);
  }
}

class MockAudit { constructor(){this.records=[];} async record(d){this.records.push(d);} }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

async function main() {
  console.log('🧪 ========== Cross-Tenant Point Tests ==========\n');

  await test('Transfer 1000 points from Tenant A to Tenant B', async () => {
    const wallet = new MockWalletAPI();
    const tenant = new MockTenantAPI();
    const audit = new MockAudit();
    const engine = new CrossTenantPointEngine({ walletAPI: wallet, tenantAPI: tenant, auditLog: audit });

    wallet.balances.set('usr_1:A', 5000);
    tenant.addRelationship('usr_1', 'A');
    tenant.addRelationship('usr_1', 'B');

    const result = await engine.transferCrossTenant({
      member_id: 'usr_1',
      from_tenant_id: 'A',
      to_tenant_id: 'B',
      amount: 1000,
      reason: 'CUSTOMER_REQUEST'
    });

    assert.strictEqual(result.source_amount, 1000);
    assert.strictEqual(result.target_amount, 1000);  // 1:1
    assert.strictEqual(await wallet.getBalance('usr_1', 'A'), 4000);
    assert.strictEqual(await wallet.getBalance('usr_1', 'B'), 1000);
    assert.strictEqual(wallet.transactions.length, 2);
  });

  await test('Custom exchange rate: 1.5x', async () => {
    const wallet = new MockWalletAPI();
    const tenant = new MockTenantAPI();
    const audit = new MockAudit();
    const engine = new CrossTenantPointEngine({ walletAPI: wallet, tenantAPI: tenant, auditLog: audit });

    wallet.balances.set('usr_2:A', 1000);
    tenant.addRelationship('usr_2', 'A');
    tenant.addRelationship('usr_2', 'B');

    const result = await engine.transferCrossTenant({
      member_id: 'usr_2',
      from_tenant_id: 'A',
      to_tenant_id: 'B',
      amount: 1000,
      exchange_rate: 1.5
    });

    assert.strictEqual(result.target_amount, 1500);  // 1000 × 1.5
    assert.strictEqual(await wallet.getBalance('usr_2', 'B'), 1500);
  });

  await test('Reject: same tenant', async () => {
    const engine = new CrossTenantPointEngine({
      walletAPI: new MockWalletAPI(),
      tenantAPI: new MockTenantAPI()
    });

    try {
      await engine.transferCrossTenant({
        member_id: 'usr_3', from_tenant_id: 'A', to_tenant_id: 'A', amount: 100
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('SAME_TENANT'));
    }
  });

  await test('Reject: no relationship with source tenant', async () => {
    const wallet = new MockWalletAPI();
    const tenant = new MockTenantAPI();
    const engine = new CrossTenantPointEngine({ walletAPI: wallet, tenantAPI: tenant });

    tenant.addRelationship('usr_4', 'B');  // ไม่ add A

    try {
      await engine.transferCrossTenant({
        member_id: 'usr_4', from_tenant_id: 'A', to_tenant_id: 'B', amount: 100
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('NO_RELATIONSHIP'));
    }
  });

  await test('Reject: insufficient balance', async () => {
    const wallet = new MockWalletAPI();
    const tenant = new MockTenantAPI();
    const engine = new CrossTenantPointEngine({ walletAPI: wallet, tenantAPI: tenant });

    wallet.balances.set('usr_5:A', 100);
    tenant.addRelationship('usr_5', 'A');
    tenant.addRelationship('usr_5', 'B');

    try {
      await engine.transferCrossTenant({
        member_id: 'usr_5', from_tenant_id: 'A', to_tenant_id: 'B', amount: 500
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('INSUFFICIENT'));
    }
  });

  await test('Reject: amount <= 0', async () => {
    const engine = new CrossTenantPointEngine({
      walletAPI: new MockWalletAPI(),
      tenantAPI: new MockTenantAPI()
    });

    try {
      await engine.transferCrossTenant({
        member_id: 'usr_6', from_tenant_id: 'A', to_tenant_id: 'B', amount: 0
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('POSITIVE'));
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
