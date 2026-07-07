// KYC Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { KYCEngine } = require('./kyc-engine.js');

function makeAudit() { return { _l: [], async log(e) { this._l.push(e); return { id: 'a' }; } }; }
function makeBus() { return { _e: [], async publish(t, p) { this._e.push({ t, p }); } }; }
function makeNotif() { return { _n: [], async send(p) { this._n.push(p); return { status: 'sent' }; } }; }
function makeMembers() {
  return {
    _members: { 'M-1': { member_id: 'M-1', tier: 'free' }, 'M-2': { member_id: 'M-2', tier: 'free' }, 'M-3': { member_id: 'M-3', tier: 'free' }, 'M-4': { member_id: 'M-4', tier: 'free' }, 'M-5': { member_id: 'M-5', tier: 'free' }, 'M-6': { member_id: 'M-6', tier: 'free' }, 'M-7': { member_id: 'M-7', tier: 'free' }, 'M-8': { member_id: 'M-8', tier: 'free' } },
    async get(id) { return this._members[id] || null; },
    async update(id, updates) { if (this._members[id]) Object.assign(this._members[id], updates); return this._members[id]; },
  };
}

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n🏛️ KYC Engine — Tests\n');

(async () => {
  const audit = makeAudit();
  const bus = makeBus();
  const notif = makeNotif();
  const members = makeMembers();
  const engine = new KYCEngine({ auditEngine: audit, eventBus: bus, notificationService: notif, memberService: members });

  // Add reviewers
  await engine.addReviewer({ reviewer_id: 'R-1', name: 'Alice', email: 'alice@x.com' });
  await engine.addReviewer({ reviewer_id: 'R-2', name: 'Bob', email: 'bob@x.com' });

  // === submitApplication ===
  await test('T01: submitApplication requires member_id', async () => {
    try { await engine.submitApplication({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: submitApplication rejects Level 1 (use auto)', async () => {
    try { await engine.submitApplication({ member_id: 'M-1', level: 1 }); assert(false); }
    catch (e) { assertContains(e.message, 'Level 2/3', 'wrong error'); }
  });

  await test('T03: submitApplication Level 2 with auto-assign', async () => {
    const r = await engine.submitApplication({ member_id: 'M-1', level: 2, business_name: 'Bangkok Cafe', business_license: 'BL-001', tax_id: 'TAX-001' });
    assertEq(r.status, 'in_review');
    assertEq(r.assigned_reviewer_id, 'R-1');
    assert(r.sla_deadline, 'has SLA deadline');
  });

  await test('T04: submitApplication rejects duplicate pending', async () => {
    try { await engine.submitApplication({ member_id: 'M-1', level: 2 }); assert(false); }
    catch (e) { assertContains(e.message, 'already exists', 'wrong error'); }
  });

  await test('T05: submitApplication level 3 (72h SLA)', async () => {
    // cancel previous first
    await engine.applications.clear();
    const r = await engine.submitApplication({ member_id: 'M-1', level: 3 });
    const sla = new Date(r.sla_deadline) - new Date(r.submitted_at);
    assert(sla > 70 * 60 * 60 * 1000, 'SLA > 70h');
  });

  // === uploadDocument ===
  await test('T06: uploadDocument requires all fields', async () => {
    try { await engine.uploadDocument({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T07: uploadDocument saves to store', async () => {
    const r = await engine.submitApplication({ member_id: 'M-2', level: 2 });
    const d = await engine.uploadDocument({
      application_id: r.application_id,
      document_type: 'business_license', file_name: 'license.pdf', file_url: 'https://x.com/license.pdf',
    });
    assert(d.document_id.startsWith('DOC-'));
    assertEq(d.document_type, 'business_license');
  });

  await test('T08: uploadDocument rejects approved application', async () => {
    const r = await engine.submitApplication({ member_id: 'M-3', level: 2 });
    await engine.approve({ application_id: r.application_id, reviewer_id: r.assigned_reviewer_id });
    try { await engine.uploadDocument({ application_id: r.application_id, document_type: 'x', file_name: 'y.pdf', file_url: 'z' }); assert(false); }
    catch (e) { assertContains(e.message, 'approved', 'wrong error'); }
  });

  // === approve / reject / requestMoreInfo ===
  await test('T09: approve updates status + member tier', async () => {
    const r = await engine.submitApplication({ member_id: 'M-4', level: 2 });
    const updated = await engine.approve({ application_id: r.application_id, reviewer_id: r.assigned_reviewer_id, notes: 'all good' });
    assertEq(updated.status, 'approved');
    assertEq(updated.decision, 'approved');
    assertEq(members._members['M-4'].tier, 'pro', 'tier upgraded');
  });

  await test('T10: approve requires reason (notes optional, but for reject required)', async () => {
    const r = await engine.submitApplication({ member_id: 'M-5', level: 2 });
    try { await engine.reject({ application_id: r.application_id, reviewer_id: r.assigned_reviewer_id }); assert(false); }
    catch (e) { assertContains(e.message, 'reason', 'wrong error'); }
  });

  await test('T11: reject requires reason', async () => {
    const r = await engine.submitApplication({ member_id: 'M-6', level: 2 });
    const updated = await engine.reject({ application_id: r.application_id, reviewer_id: r.assigned_reviewer_id, reason: 'documents unclear' });
    assertEq(updated.status, 'rejected');
    assertEq(updated.decision_reason, 'documents unclear');
  });

  await test('T12: requestMoreInfo extends SLA by 24h', async () => {
    const r = await engine.submitApplication({ member_id: 'M-7', level: 2 });
    const oldSla = r.sla_deadline;
    const updated = await engine.requestMoreInfo({ application_id: r.application_id, reviewer_id: r.assigned_reviewer_id, message: 'need more tax docs' });
    assertEq(updated.status, 'more_info_required');
    assert(updated.sla_deadline > oldSla, 'SLA extended');
  });

  await test('T13: approve rejects if not assigned reviewer', async () => {
    const r = await engine.submitApplication({ member_id: 'M-8', level: 2 });
    try { await engine.approve({ application_id: r.application_id, reviewer_id: 'R-OTHER' }); assert(false); }
    catch (e) { assertContains(e.message, 'assigned reviewer', 'wrong error'); }
  });

  // === getStatus ===
  await test('T14: getStatus returns no_application for unknown', async () => {
    const r = await engine.getStatus('M-UNKNOWN');
    assertEq(r.has_application, false);
  });

  await test('T15: getStatus returns application with documents', async () => {
    const r = await engine.getStatus('M-1');
    assert(r.has_application);
    assert(Array.isArray(r.documents));
  });

  // === getReviewerQueue ===
  await test('T16: getReviewerQueue filters by reviewer', async () => {
    const r = await engine.getReviewerQueue({ reviewer_id: 'R-1' });
    assert(r.items.every((a) => a.assigned_reviewer_id === 'R-1'));
  });

  await test('T17: getReviewerQueue sorts by SLA (urgent first)', async () => {
    const r = await engine.getReviewerQueue({});
    for (let i = 1; i < r.items.length; i++) {
      assert(r.items[i - 1].sla_deadline <= r.items[i].sla_deadline, 'sorted by SLA');
    }
  });

  // === addReviewer ===
  await test('T18: addReviewer requires all fields', async () => {
    try { await engine.addReviewer({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  // === getStats ===
  await test('T19: getStats aggregates counts', async () => {
    const s = await engine.getStats({});
    assert(s.total > 0);
    assert(s.approved >= 0);
  });

  await test('T20: getStats calculates SLA breaches', async () => {
    const s = await engine.getStats({});
    assert(typeof s.sla_breaches === 'number');
  });

  // === Round-robin ===
  await test('T21: round-robin alternates reviewers', async () => {
    const a1 = await engine.submitApplication({ member_id: 'M-A', level: 2 });
    const a2 = await engine.submitApplication({ member_id: 'M-B', level: 2 });
    const a3 = await engine.submitApplication({ member_id: 'M-C', level: 2 });
    assert(a1.assigned_reviewer_id === 'R-1' || a1.assigned_reviewer_id === 'R-2');
    // They should alternate
    assert(a1.assigned_reviewer_id !== a2.assigned_reviewer_id, 'alternates');
  });

  // === Events ===
  await test('T22: submitApplication publishes event', async () => {
    const before = bus._e.filter((e) => e.t === 'kyc.application_submitted').length;
    await engine.submitApplication({ member_id: 'M-NEW', level: 2 });
    const after = bus._e.filter((e) => e.t === 'kyc.application_submitted').length;
    assert(after > before);
  });

  await test('T23: approve sends notification to applicant', async () => {
    const r = await engine.submitApplication({ member_id: 'M-NOTIF', level: 2 });
    const before = notif._n.length;
    await engine.approve({ application_id: r.application_id, reviewer_id: r.assigned_reviewer_id });
    const after = notif._n.length;
    assert(after > before);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
