// Lotto Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { LottoEngine } = require('./lotto-engine.js');

function makeMembers(features = ['lotto_weekly']) {
  return {
    _members: { 'M-1': { member_id: 'M-1', features }, 'M-2': { member_id: 'M-2', features }, 'M-3': { member_id: 'M-3', features: [] } },
    async get(id) { return this._members[id] || null; },
  };
}
function makeTokens() {
  return {
    _debits: [], _credits: [],
    async debit({ member_id, amount, claim_id }) {
      const e = this._debits.find((d) => d.claim_id === claim_id);
      if (e) return e;
      const txn = { txn_id: `DBT-${this._debits.length + 1}`, claim_id, member_id, amount };
      this._debits.push(txn);
      return txn;
    },
    async credit({ member_id, amount, claim_id }) {
      const e = this._credits.find((c) => c.claim_id === claim_id);
      if (e) return e;
      const txn = { txn_id: `CRD-${this._credits.length + 1}`, claim_id, member_id, amount };
      this._credits.push(txn);
      return txn;
    },
  };
}
function makeAudit() { return { _l: [], async log(e) { this._l.push(e); return { id: 'a' }; } }; }
function makeBus() { return { _e: [], async publish(t, p) { this._e.push({ t, p }); } }; }
function makeRng() {
  // Deterministic for tests: always pick first ticket
  return { nextInt: (min, max) => min };
}

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n🎰 Lotto Engine — Tests\n');

(async () => {
  const engine = new LottoEngine({
    memberService: makeMembers(),
    tokenEngine: makeTokens(),
    auditEngine: makeAudit(),
    eventBus: makeBus(),
    rng: makeRng(),
  });

  // === createRound ===
  await test('T01: createRound requires all fields', async () => {
    try { await engine.createRound({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: createRound rejects negative ticket_price', async () => {
    try { await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'X', ticket_price: -1, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() }); assert(false); }
    catch (e) { assertContains(e.message, 'positive', 'wrong error'); }
  });

  await test('T03: createRound rejects missing draw_at', async () => {
    try { await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'X', ticket_price: 10, max_tickets: 10 }); assert(false); }
    catch (e) { assertContains(e.message, 'draw_at', 'wrong error'); }
  });

  await test('T04: createRound weekly with prize pool', async () => {
    const r = await engine.createRound({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      name: 'Weekly Lotto #1', ticket_price: 100, max_tickets: 100,
      prize_pool: 5000, draw_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      frequency: 'weekly', required_feature: 'lotto_weekly',
    });
    assertEq(r.prize_pool, 5000);
    assertEq(r.status, 'open');
  });

  await test('T05: createRound defaults prize_pool = ticket_price * max * 0.9', async () => {
    const r = await engine.createRound({
      merchant_id: 'MCH-1', token_id: 'TOK-1',
      name: 'Default Pool', ticket_price: 100, max_tickets: 10,
      draw_at: new Date(Date.now() + 86400000).toISOString(),
    });
    assertEq(r.prize_pool, 900);
  });

  // === buyTicket ===
  await test('T06: buyTicket requires round_id and member_id', async () => {
    try { await engine.buyTicket({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T07: buyTicket rejects unknown round', async () => {
    try { await engine.buyTicket({ round_id: 'NOPE', member_id: 'M-1' }); assert(false); }
    catch (e) { assertContains(e.message, 'not found', 'wrong error'); }
  });

  await test('T08: buyTicket with required_feature blocks non-subscriber', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'Premium', ticket_price: 50, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString(), required_feature: 'lotto_daily' });
    try { await engine.buyTicket({ round_id: r.round_id, member_id: 'M-3' }); assert(false, 'M-3 has no features'); }
    catch (e) { assertContains(e.message, 'requires', 'wrong error');
    }
  });

  await test('T09: buyTicket success with subscription feature', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R9', ticket_price: 100, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString(), required_feature: 'lotto_weekly' });
    const t = await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    assertEq(t.member_id, 'M-1');
    assertEq(t.ticket_number, 1);
    assertEq(r.tickets_sold, 1);
  });

  await test('T10: buyTicket idempotency by claim_id', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R10', ticket_price: 100, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() });
    const t1 = await engine.buyTicket({ round_id: r.round_id, member_id: 'M-2', idempotency_key: 'IDEM-001' });
    const t2 = await engine.buyTicket({ round_id: r.round_id, member_id: 'M-2', idempotency_key: 'IDEM-001' });
    assertEq(t1.ticket_id, t2.ticket_id);
  });

  await test('T11: buyTicket rejects duplicate (1 ticket per member per round)', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R11', ticket_price: 100, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() });
    await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    try { await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' }); assert(false); }
    catch (e) { assertContains(e.message, 'already has', 'wrong error'); }
  });

  await test('T12: buyTicket rejects sold out', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R12', ticket_price: 1, max_tickets: 1, draw_at: new Date(Date.now() + 86400000).toISOString() });
    await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    try { await engine.buyTicket({ round_id: r.round_id, member_id: 'M-2' }); assert(false); }
    catch (e) { assertContains(e.message, 'sold out', 'wrong error'); }
  });

  // === draw ===
  await test('T13: draw rejects round with 0 tickets', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R13', ticket_price: 1, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() });
    try { await engine.draw({ round_id: r.round_id }); assert(false); }
    catch (e) { assertContains(e.message, 'No tickets', 'wrong error'); }
  });

  await test('T14: draw picks winner (deterministic with mock RNG)', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R14', ticket_price: 1, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() });
    await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    await engine.buyTicket({ round_id: r.round_id, member_id: 'M-2' });
    const d = await engine.draw({ round_id: r.round_id });
    assertEq(d.winning_member_id, 'M-1'); // mock RNG picks first
    assertEq(r.status, 'drawn');
    assertEq(r.winning_ticket_id, d.winning_ticket_id);
  });

  await test('T15: draw sets losing tickets to lost', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R15', ticket_price: 1, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() });
    const t1 = await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    const t2 = await engine.buyTicket({ round_id: r.round_id, member_id: 'M-2' });
    await engine.draw({ round_id: r.round_id });
    assertEq(t1.status, 'won');
    assertEq(t2.status, 'lost');
  });

  await test('T16: draw rejects already-drawn round', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R16', ticket_price: 1, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() });
    await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    await engine.draw({ round_id: r.round_id });
    try { await engine.draw({ round_id: r.round_id }); assert(false); }
    catch (e) { assertContains(e.message, 'drawn', 'wrong error'); }
  });

  // === claimPrize ===
  await test('T17: claimPrize credits winner', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R17', ticket_price: 1, max_tickets: 10, prize_pool: 5, draw_at: new Date(Date.now() + 86400000).toISOString() });
    await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    const d = await engine.draw({ round_id: r.round_id });
    const c = await engine.claimPrize({ draw_id: d.draw_id });
    assertEq(c.status, 'CLAIMED');
    assertEq(c.amount, 5);
    assertEq(c.member_id, 'M-1');
  });

  await test('T18: claimPrize idempotent (ALREADY_CLAIMED)', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R18', ticket_price: 1, max_tickets: 10, prize_pool: 5, draw_at: new Date(Date.now() + 86400000).toISOString() });
    await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    const d = await engine.draw({ round_id: r.round_id });
    await engine.claimPrize({ draw_id: d.draw_id });
    const c2 = await engine.claimPrize({ draw_id: d.draw_id });
    assertEq(c2.status, 'ALREADY_CLAIMED');
  });

  // === List / Stats ===
  await test('T19: listRounds filters by status', async () => {
    const r = await engine.listRounds({ status: 'drawn' });
    assert(r.items.every((i) => i.status === 'drawn'));
  });

  await test('T20: listTickets filters by member', async () => {
    const r = await engine.listTickets({ member_id: 'M-1' });
    assert(r.items.every((t) => t.member_id === 'M-1'));
  });

  await test('T21: getStats aggregates revenue and prize', async () => {
    const s = await engine.getStats({});
    assert(s.tickets_sold > 0);
    assert(s.total_revenue > 0);
  });

  await test('T22: getRound returns full round', async () => {
    const r = Array.from(engine.rounds.values())[0];
    const got = await engine.getRound(r.round_id);
    assertEq(got.round_id, r.round_id);
  });

  await test('T23: buyTicket generates 6-digit lucky code', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R23', ticket_price: 1, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() });
    const t = await engine.buyTicket({ round_id: r.round_id, member_id: 'M-2' });
    assertEq(t.lucky_code.length, 6, 'lucky_code should be 6 digits');
  });

  await test('T24: draw publishes lotto.drawn event', async () => {
    const r = await engine.createRound({ merchant_id: 'm', token_id: 't', name: 'R24', ticket_price: 1, max_tickets: 10, draw_at: new Date(Date.now() + 86400000).toISOString() });
    await engine.buyTicket({ round_id: r.round_id, member_id: 'M-1' });
    await engine.draw({ round_id: r.round_id });
    const events = engine.bus._e.filter((e) => e.t === 'lotto.drawn');
    assert(events.length >= 1);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
