// Pocket PM Report Engine — TASK-204 tests
// 15+ unit tests, 100% pass
// Author: AliClaw | Date: 2026-07-10

const PocketPMEngine = require('./pocket-pm-engine.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

console.log('\n📋 Pocket PM Engine — TASK-204 (15 tests)\n');

// ===== Setup helpers =====
function freshEngine() {
  return new PocketPMEngine();
}

function makePocket(id, memberId, amount, source, createdAt) {
  return {
    id, memberId, amount, source,
    createdAt: createdAt || new Date().toISOString(),
    status: 'active'
  };
}

function seedDupes(engine, count = 2) {
  // member M-1, amount 100, source "BU-CAFE", 2 duplicates
  for (let i = 0; i < count; i++) {
    const id = `P-${i + 1}`;
    engine.pockets.set(id, makePocket(id, 'M-1', 100, 'BU-CAFE'));
  }
}

// ===== T01: detectDuplicates =====
test('T01: detectDuplicates finds same member+amount+source', () => {
  const e = freshEngine();
  seedDupes(e, 3);
  const dupes = e.detectDuplicates('M-1', 100, 'BU-CAFE');
  assertEq(dupes.length, 3, 'should find 3 dupes');
});

// ===== T02: detectDuplicates empty =====
test('T02: detectDuplicates returns empty for no match', () => {
  const e = freshEngine();
  seedDupes(e, 2);
  const dupes = e.detectDuplicates('M-99', 100, 'BU-CAFE');
  assertEq(dupes.length, 0);
});

// ===== T03: detectDuplicates windowMs =====
test('T03: detectDuplicates respects time window', () => {
  const e = freshEngine();
  const old = new Date(Date.now() - 120000).toISOString(); // 2 min ago
  e.pockets.set('P-1', makePocket('P-1', 'M-1', 100, 'BU-CAFE', old));
  const dupes = e.detectDuplicates('M-1', 100, 'BU-CAFE', 60000);
  assertEq(dupes.length, 0, 'old pocket outside 60s window');
});

// ===== T04: scanAllDuplicates groups by key =====
test('T04: scanAllDuplicates groups by member+amount+source', () => {
  const e = freshEngine();
  seedDupes(e, 3);
  e.pockets.set('P-10', makePocket('P-10', 'M-2', 50, 'BU-SHOP'));
  const groups = e.scanAllDuplicates();
  assertEq(groups.length, 1, 'only 1 dupe group');
  assertEq(groups[0].count, 3);
  assertEq(groups[0].duplicates, 2, '2 duplicates (original + 2 copies)');
  assertEq(groups[0].totalImpact, 200, '2 copies × 100 = 200');
});

// ===== T05: scanAllDuplicates no dupes =====
test('T05: scanAllDuplicates empty when no dupes', () => {
  const e = freshEngine();
  e.pockets.set('P-1', makePocket('P-1', 'M-1', 100, 'BU-CAFE'));
  e.pockets.set('P-2', makePocket('P-2', 'M-2', 100, 'BU-CAFE'));
  const groups = e.scanAllDuplicates();
  assertEq(groups.length, 0, 'different members = not dupe');
});

// ===== T06: generateDailyReport =====
test('T06: generateDailyReport summary counts', () => {
  const e = freshEngine();
  seedDupes(e, 3); // 1 group: M-1, 100, BU-CAFE × 3
  e.pockets.set('P-10', makePocket('P-10', 'M-2', 50, 'BU-SHOP'));
  e.pockets.set('P-11', makePocket('P-11', 'M-2', 50, 'BU-SHOP')); // group 2
  const report = e.generateDailyReport();
  assertEq(report.summary.totalDuplicates, 2, '2 dupe groups total');
  assertEq(report.summary.affectedMembers, 2, '2 affected members');
  assertEq(report.summary.totalImpactAmount, 250, '2 + 1 = 3 copies × amount');
});

// ===== T07: recordDecision =====
test('T07: recordDecision creates pending decision', () => {
  const e = freshEngine();
  seedDupes(e, 2);
  const decision = e.recordDecision('M-1|100|BU-CAFE', 'PM-001', 'reject_copies');
  assertEq(decision.status, 'pending');
  assertEq(decision.action, 'reject_copies');
  assertEq(decision.copyCount, 1);
  assert(decision.decisionId.startsWith('DEC-'));
});

// ===== T08: recordDecision invalid action =====
test('T08: recordDecision throws on invalid action', () => {
  const e = freshEngine();
  seedDupes(e, 2);
  let threw = false;
  try { e.recordDecision('M-1|100|BU-CAFE', 'PM-001', 'delete_all'); }
  catch (err) { threw = true; }
  assert(threw, 'should throw on invalid action');
});

// ===== T09: applyDecision reject_copies =====
test('T09: applyDecision marks copies as rejected', () => {
  const e = freshEngine();
  seedDupes(e, 3);
  const decision = e.recordDecision('M-1|100|BU-CAFE', 'PM-001', 'reject_copies');
  const result = e.applyDecision(decision.decisionId);
  assertEq(result.status, 'applied');
  assertEq(result.affected, 2, '2 copies rejected');
  // P-1 (original) should still be active
  assertEq(e.pockets.get('P-1').status, 'active');
  // P-2, P-3 (copies) should be rejected
  assertEq(e.pockets.get('P-2').status, 'rejected');
  assertEq(e.pockets.get('P-3').status, 'rejected');
  assertEq(e.pockets.get('P-2').rejectionReason, 'duplicate_by_pm');
});

// ===== T10: applyDecision keep_all =====
test('T10: applyDecision keep_all does not modify pockets', () => {
  const e = freshEngine();
  seedDupes(e, 2);
  const decision = e.recordDecision('M-1|100|BU-CAFE', 'PM-001', 'keep_all');
  const result = e.applyDecision(decision.decisionId);
  assertEq(result.affected, 0, 'keep_all affects 0 pockets');
  assertEq(e.pockets.get('P-1').status, 'active');
  assertEq(e.pockets.get('P-2').status, 'active');
});

// ===== T11: applyDecision already applied =====
test('T11: applyDecision throws on already-applied', () => {
  const e = freshEngine();
  seedDupes(e, 2);
  const d = e.recordDecision('M-1|100|BU-CAFE', 'PM-001', 'reject_copies');
  e.applyDecision(d.decisionId);
  let threw = false;
  try { e.applyDecision(d.decisionId); } catch (err) { threw = true; }
  assert(threw);
});

// ===== T12: notifyPM =====
test('T12: notifyPM creates notification record', () => {
  const e = freshEngine();
  seedDupes(e, 2);
  const report = e.generateDailyReport();
  const notif = e.notifyPM(report);
  assertEq(notif.type, 'pocket_dupes_daily');
  assertEq(notif.channel, 'email');
  assert(notif.subject.includes('1 กลุ่มซ้ำ'), 'subject mentions 1 dupe group');
  assert(notif.notifId.startsWith('NOTIF-POCKET-'));
});

// ===== T13: listDecisions =====
test('T13: listDecisions filters by status', () => {
  const e = freshEngine();
  seedDupes(e, 2);
  const d1 = e.recordDecision('M-1|100|BU-CAFE', 'PM-001', 'reject_copies');
  e.applyDecision(d1.decisionId);
  const all = e.listDecisions();
  const pending = e.listDecisions('pending');
  const applied = e.listDecisions('applied');
  assertEq(all.length, 1);
  assertEq(pending.length, 0);
  assertEq(applied.length, 1);
});

// ===== T14: scanAllDuplicates original identification =====
test('T14: scanAllDuplicates identifies original (earliest)', () => {
  const e = freshEngine();
  const t0 = new Date('2026-07-10T10:00:00Z').toISOString();
  const t1 = new Date('2026-07-10T10:00:30Z').toISOString();
  const t2 = new Date('2026-07-10T10:01:00Z').toISOString();
  e.pockets.set('P-A', makePocket('P-A', 'M-1', 100, 'BU', t0));
  e.pockets.set('P-B', makePocket('P-B', 'M-1', 100, 'BU', t2));
  e.pockets.set('P-C', makePocket('P-C', 'M-1', 100, 'BU', t1));
  const groups = e.scanAllDuplicates();
  assertEq(groups[0].original.id, 'P-A', 'P-A is original (earliest)');
  assertEq(groups[0].copies.length, 2);
});

// ===== T15: detectDuplicates excludes rejected =====
test('T15: detectDuplicates ignores rejected pockets', () => {
  const e = freshEngine();
  const p = makePocket('P-1', 'M-1', 100, 'BU-CAFE');
  p.status = 'rejected';
  e.pockets.set('P-1', p);
  const dupes = e.detectDuplicates('M-1', 100, 'BU-CAFE');
  assertEq(dupes.length, 0, 'rejected pockets excluded');
});

// ===== T16: multi-source scanAllDuplicates =====
test('T16: scanAllDuplicates handles multiple sources', () => {
  const e = freshEngine();
  e.pockets.set('P-1', makePocket('P-1', 'M-1', 100, 'BU-CAFE'));
  e.pockets.set('P-2', makePocket('P-2', 'M-1', 100, 'BU-CAFE'));
  e.pockets.set('P-3', makePocket('P-3', 'M-1', 100, 'BU-SHOP'));
  e.pockets.set('P-4', makePocket('P-4', 'M-1', 100, 'BU-SHOP'));
  const groups = e.scanAllDuplicates();
  assertEq(groups.length, 2, '2 dupe groups (one per source)');
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
