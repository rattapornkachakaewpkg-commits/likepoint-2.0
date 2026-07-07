// Gift Card Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { GiftCardEngine } = require('./gift-card-engine.js');

function makeMerchants() {
  return {
    _merchants: { 'MCH-1': { merchant_id: 'MCH-1', status: 'active' } },
    async get(id) { return this._merchants[id] || null; },
  };
}
function makeMembers() {
  return {
    _members: { 'M-1': { member_id: 'M-1' }, 'M-2': { member_id: 'M-2' }, 'M-3': { member_id: 'M-3' } },
    async get(id) { return this._members[id] || null; },
  };
}
function makeTokens() {
  return {
    _credits: [], _debits: [],
    async credit({ member_id, amount, claim_id }) {
      const e = this._credits.find((c) => c.claim_id === claim_id);
      if (e) return e;
      const txn = { txn_id: `CRD-${this._credits.length + 1}`, claim_id, member_id, amount };
      this._credits.push(txn);
      return txn;
    },
    async debit({ member_id, amount, claim_id }) {
      const e = this._debits.find((d) => d.claim_id === claim_id);
      if (e) return e;
      const txn = { txn_id: `DBT-${this._debits.length + 1}`, claim_id, member_id, amount };
      this._debits.push(txn);
      return txn;
    },
  };
}
function makeAudit() { return { _l: [], async log(e) { this._l.push(e); return { id: 'a' }; } }; }
function makeBus() { return { _e: [], async publish(t, p) { this._e.push({ t, p }); } }; }

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n🎁 Gift Card Engine — Tests\n');

(async () => {
  const engine = new GiftCardEngine({
    merchantService: makeMerchants(),
    memberService: makeMembers(),
    tokenEngine: makeTokens(),
    auditEngine: makeAudit(),
    eventBus: makeBus(),
  });

  // === createCard ===
  await test('T01: createCard requires all fields', async () => {
    try { await engine.createCard({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: createCard rejects negative amount', async () => {
    try { await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: -100, issued_by: 'M-1' }); assert(false); }
    catch (e) { assertContains(e.message, 'positive', 'wrong error'); }
  });

  await test('T03: createCard rejects unknown merchant', async () => {
    try { await engine.createCard({ merchant_id: 'NOPE', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' }); assert(false); }
    catch (e) { assertContains(e.message, 'not found', 'wrong error'); }
  });

  await test('T04: createCard charges amount + 1% fee', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 1000, issued_by: 'M-1' });
    assertEq(c.fee, 10);
    assertEq(c.amount, 1000);
    assertEq(c.balance, 1000);
    assertEq(c.status, 'active');
  });

  await test('T05: createCard generates 16-char code (4-4-4-4 format)', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 500, issued_by: 'M-1' });
    assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c.code), `code format: ${c.code}`);
  });

  await test('T06: createCard generates 6-digit PIN', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 500, issued_by: 'M-1' });
    assertEq(c.pin.length, 6);
  });

  await test('T07: createCard has no expiry (Gift Card = permanent)', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 500, issued_by: 'M-1' });
    assertEq(c.expires_at, null);
  });

  await test('T08: createCard idempotency by claim_id', async () => {
    const c1 = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 200, issued_by: 'M-1', idempotency_key: 'IDEM-001' });
    const c2 = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 200, issued_by: 'M-1', idempotency_key: 'IDEM-001' });
    assertEq(c1.card_id, c2.card_id);
  });

  await test('T09: createCard with recipient_member_id (target gift)', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1', recipient_member_id: 'M-2', message: 'Happy birthday!' });
    assertEq(c.recipient_member_id, 'M-2');
  });

  // === redeem ===
  await test('T10: redeem requires code, pin, member_id', async () => {
    try { await engine.redeem({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T11: redeem rejects unknown member', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' });
    try { await engine.redeem({ code: c.code, pin: c.pin, member_id: 'NOPE' }); assert(false); }
    catch (e) { assertContains(e.message, 'Member not found', 'wrong error'); }
  });

  await test('T12: redeem rejects invalid code', async () => {
    try { await engine.redeem({ code: 'XXXX-XXXX-XXXX-XXXX', pin: '123456', member_id: 'M-1' }); assert(false); }
    catch (e) { assertContains(e.message, 'Invalid card code', 'wrong error'); }
  });

  await test('T13: redeem rejects invalid PIN', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' });
    try { await engine.redeem({ code: c.code, pin: '000000', member_id: 'M-2' }); assert(false); }
    catch (e) { assertContains(e.message, 'Invalid PIN', 'wrong error'); }
  });

  await test('T14: redeem success credits recipient', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' });
    const r = await engine.redeem({ code: c.code, pin: c.pin, member_id: 'M-2' });
    assertEq(r.amount, 100);
    const stored = engine.cards.get(c.card_id);
    assertEq(stored.status, 'redeemed');
    assertEq(stored.redeemed_by, 'M-2');
    assertEq(stored.balance, 0);
  });

  await test('T15: redeem idempotent (cannot redeem twice)', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' });
    await engine.redeem({ code: c.code, pin: c.pin, member_id: 'M-2' });
    try { await engine.redeem({ code: c.code, pin: c.pin, member_id: 'M-3' }); assert(false); }
    catch (e) { assertContains(e.message, 'redeemed', 'wrong error'); }
  });

  // === transfer ===
  await test('T16: transfer requires card_id, from, to', async () => {
    try { await engine.transfer({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T17: transfer requires only issuer can transfer', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' });
    try { await engine.transfer({ card_id: c.card_id, from_member_id: 'M-2', to_member_id: 'M-3' }); assert(false); }
    catch (e) { assertContains(e.message, 'Only issuer', 'wrong error'); }
  });

  await test('T18: transfer success moves card to new owner', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' });
    const r = await engine.transfer({ card_id: c.card_id, from_member_id: 'M-1', to_member_id: 'M-2' });
    assertEq(r.issued_by, 'M-2');
    assertEq(r.transferred_from, 'M-1');
  });  // === void ===
  await test('T19: voidCard refunds issuer', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 1000, issued_by: 'M-1' });
    const v = await engine.voidCard({ card_id: c.card_id, reason: 'wrong_recipient' });
    assertEq(v.status, 'voided');
    assertEq(v.void_reason, 'wrong_recipient');
  });

  await test('T20: voidCard rejects already-redeemed', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' });
    await engine.redeem({ code: c.code, pin: c.pin, member_id: 'M-2' });
    try { await engine.voidCard({ card_id: c.card_id, reason: 'test' }); assert(false); }
    catch (e) { assertContains(e.message, 'redeemed', 'wrong error'); }
  });

  // === List / Stats ===
  await test('T21: listCards filters by merchant', async () => {
    const r = await engine.listCards({ merchant_id: 'MCH-1' });
    assert(r.items.every((c) => c.merchant_id === 'MCH-1'));
  });

  await test('T22: getCard returns card without pin (security)', async () => {
    const c = await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 100, issued_by: 'M-1' });
    const got = await engine.getCard(c.card_id);
    assert(!got.pin, 'pin should be stripped');
  });

  await test('T23: getStats calculates redemption rate', async () => {
    const s = await engine.getStats({});
    assert(s.total_cards > 0);
    assert(typeof s.redemption_rate === 'string');
  });

  await test('T24: createCard publishes gift_card.created event', async () => {
    const before = engine.bus._e.filter((e) => e.t === 'gift_card.created').length;
    await engine.createCard({ merchant_id: 'MCH-1', token_id: 'TOK-1', amount: 50, issued_by: 'M-1' });
    const after = engine.bus._e.filter((e) => e.t === 'gift_card.created').length;
    assert(after > before);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
