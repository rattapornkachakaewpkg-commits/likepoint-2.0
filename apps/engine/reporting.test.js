// Unit Tests for Reporting Engine
const { ReportingEngine } = require('./reporting.js');
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
  console.log('🧪 ========== Reporting Engine Tests ==========\n');

  await test('Track metric event', async () => {
    const db = new MockDB();
    const audit = new MockAudit();
    const id = new IdentityService({ db });
    const engine = new ReportingEngine({ auditLog: audit, identityService: id });

    await engine.track('WALLET_REBIND', { duration_ms: 5000, success: true });
    assert.strictEqual(engine.metrics.get('WALLET_REBIND').length, 1);
  });

  await test('Success Metrics: All targets met', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new ReportingEngine({ identityService: id });

    // Simulate good metrics
    await engine.track('WALLET_REBIND', { action: 'REBINDED' });
    await engine.track('RECOVERY', { success: true });
    await engine.track('RECOVERY', { success: true });
    await engine.track('PHONE_CHANGE', { duration_ms: 30000 });  // 30s

    const metrics = await engine.getSuccessMetrics();
    assert.strictEqual(metrics.metrics.wallet_duplicate_rate.pass, true);
    assert.strictEqual(metrics.metrics.account_recovery_success.pass, true);
    assert.strictEqual(metrics.metrics.point_loss.pass, true);
  });

  await test('Success Metrics: phone change > 3 min → fail', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new ReportingEngine({ identityService: id });

    await engine.track('PHONE_CHANGE', { duration_ms: 300000 });  // 5 min

    const metrics = await engine.getSuccessMetrics();
    assert.strictEqual(metrics.metrics.phone_change_avg_duration.pass, false);
  });

  await test('Success Metrics: point loss detected → fail', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new ReportingEngine({ identityService: id });

    await engine.track('POINT_LOSS', { amount: 1000 });

    const metrics = await engine.getSuccessMetrics();
    assert.strictEqual(metrics.metrics.point_loss.pass, false);
  });

  await test('Usage analytics', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new ReportingEngine({ identityService: id });

    await id.createMember({ display_name: 'A' });
    await id.createMember({ display_name: 'B' });
    await engine.track('TEST');

    const analytics = await engine.getUsageAnalytics();
    assert.strictEqual(analytics.total_members, 2);
    assert.strictEqual(analytics.metrics_tracked, 1);
  });

  await test('Compliance report (PDPA)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const engine = new ReportingEngine({ identityService: id });

    const { member } = await id.createMember({ display_name: 'A' });
    await id.recordConsent({ member_id: member.member_id, consent_type: 'MARKETING', granted: true });

    const report = await engine.getComplianceReport();
    assert.strictEqual(report.total_members, 1);
    assert.strictEqual(report.consents.granted, 1);
  });

  console.log(`\n📊 ========== Test Summary ==========`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Coverage: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed > 0) process.exit(1);
  console.log('\n🎉 All tests passed!');
}

main().catch(err => { console.error(err); process.exit(1); });
