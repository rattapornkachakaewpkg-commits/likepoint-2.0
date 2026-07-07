// Unit Tests for Tenant Service Engine
const { TenantService } = require('./tenant-service.js');
const { IdentityService } = require('../identity-service/member.js');
const { NotificationService } = require('./notification.js');
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
  console.log('🧪 ========== Tenant Service Tests ==========\n');

  await test('CRM: Get default profile (auto-create)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const store = { crm: new Map(), campaigns: new Map(), consents: new Map() };
    const ts = new TenantService({ identityService: id, db: store });
    const { member } = await id.createMember({ display_name: 'A' });

    const profile = await ts.getCRMProfile(member.member_id, 'tenant_A');
    assert.strictEqual(profile.tier, 'BRONZE');
    assert.strictEqual(profile.total_spent, 0);
  });

  await test('CRM: Update tier (BRONZE → GOLD)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const store = { crm: new Map(), campaigns: new Map(), consents: new Map() };
    const ts = new TenantService({ identityService: id, db: store });
    const { member } = await id.createMember({ display_name: 'B' });

    const updated = await ts.updateCRMProfile(member.member_id, 'tenant_A', { tier: 'GOLD' });
    assert.strictEqual(updated.tier, 'GOLD');
  });

  await test('Campaign: Create new campaign', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const store = { crm: new Map(), campaigns: new Map(), consents: new Map() };
    const ts = new TenantService({ identityService: id, db: store });

    const campaign = await ts.createCampaign({
      tenant_id: 'tenant_A',
      name: 'BCT Special 1000P',
      type: 'BCT',
      reward_amount: 1000,
      start_at: new Date().toISOString(),
      end_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      criteria: { tier: 'GOLD' }
    });

    assert.ok(campaign.campaign_id.startsWith('tnt_'));
    assert.strictEqual(campaign.status, 'DRAFT');
  });

  await test('Campaign: Activate + send notifications to target', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const notif = new NotificationService();
    // shared store
    const store = { crm: new Map(), campaigns: new Map(), consents: new Map() };
    const ts = new TenantService({ identityService: id, notificationService: notif, db: store });

    // Create 3 members, 1 with GOLD tier
    const { member: a } = await id.createMember({ display_name: 'A' });
    const { member: b } = await id.createMember({ display_name: 'B' });
    const { member: c } = await id.createMember({ display_name: 'C' });
    await ts.updateCRMProfile(a.member_id, 'tenant_X', { tier: 'GOLD' });
    await ts.updateCRMProfile(b.member_id, 'tenant_X', { tier: 'BRONZE' });
    await ts.updateCRMProfile(c.member_id, 'tenant_X', { tier: 'GOLD' });

    const campaign = await ts.createCampaign({
      tenant_id: 'tenant_X',
      name: 'GOLD Member 500P',
      type: 'BCT',
      reward_amount: 500,
      criteria: { tier: 'GOLD' }
    });

    const activated = await ts.activateCampaign(campaign.campaign_id);
    assert.strictEqual(activated.status, 'ACTIVE');
    assert.strictEqual(activated.enrolled_members.length, 2);  // A + C

    // Verify notifications sent
    assert.strictEqual(notif.sent.length, 2);
  });

  await test('Consent: Record + check', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const store = { crm: new Map(), campaigns: new Map(), consents: new Map() };
    const ts = new TenantService({ identityService: id, db: store });
    const { member } = await id.createMember({ display_name: 'A' });

    await ts.recordConsent({ member_id: member.member_id, tenant_id: 'tenant_A', consent_type: 'MARKETING', granted: true });
    const has = await ts.hasConsent(member.member_id, 'tenant_A', 'MARKETING');
    assert.strictEqual(has, true);
  });

  await test('Consent: Revoke (PDPA right to withdraw)', async () => {
    const db = new MockDB();
    const id = new IdentityService({ db });
    const store = { crm: new Map(), campaigns: new Map(), consents: new Map() };
    const ts = new TenantService({ identityService: id, db: store });
    const { member } = await id.createMember({ display_name: 'A' });

    await ts.recordConsent({ member_id: member.member_id, tenant_id: 'tenant_A', consent_type: 'MARKETING', granted: true });
    await ts.revokeConsent(member.member_id, 'tenant_A', 'MARKETING');

    const has = await ts.hasConsent(member.member_id, 'tenant_A', 'MARKETING');
    assert.strictEqual(has, false);
  });

  console.log(`\n📊 ========== Test Summary ==========`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Coverage: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed > 0) process.exit(1);
  console.log('\n🎉 All tests passed!');
}

main().catch(err => { console.error(err); process.exit(1); });
