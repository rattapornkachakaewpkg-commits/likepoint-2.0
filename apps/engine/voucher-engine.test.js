// Voucher Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { VoucherEngine } = require('./voucher-engine.js');

function makeMerchants() {
  return {
    _merchants: { 'MCH-1': { merchant_id: 'MCH-1', status: 'active' } },
    async get(id) { return this._merchants[id] || null; },
  };
}
function makeMembers() {
  return {
    _members: { 'M-1': { member_id: 'M-1' }, 'M-2': { member_id: 'M-2' } },
    async get(id) { return this._members[id] || null; },
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

console.log('\n🎫 Voucher Engine — Tests\n');

(async () => {
  const engine = new VoucherEngine({
    merchantService: makeMerchants(),
    memberService: makeMembers(),
    auditEngine: makeAudit(),
    eventBus: makeBus(),
  });

  // === createVoucher ===
  await test('T01: createVoucher requires all fields', async () => {
    try { await engine.createVoucher({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: createVoucher rejects invalid discount_type', async () => {
    try {
      await engine.createVoucher({
        merchant_id: 'MCH-1', name: 'X', discount_type: 'bogo', discount_value: 10,
        valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
      });
      assert(false);
    } catch (e) { assertContains(e.message, 'discount_type', 'wrong error'); }
  });

  await test('T03: createVoucher rejects percentage > 100', async () => {
    try {
      await engine.createVoucher({
        merchant_id: 'MCH-1', name: 'X', discount_type: 'percentage', discount_value: 150,
        valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
      });
      assert(false);
    } catch (e) { assertContains(e.message, '0-100', 'wrong error'); }
  });

  await test('T04: createVoucher rejects valid_until before valid_from', async () => {
    try {
      await engine.createVoucher({
        merchant_id: 'MCH-1', name: 'X', discount_type: 'fixed', discount_value: 50,
        valid_from: new Date(Date.now() + 86400000).toISOString(),
        valid_until: new Date().toISOString(),
      });
      assert(false);
    } catch (e) { assertContains(e.message, 'after', 'wrong error'); }
  });

  await test('T05: createVoucher with auto-generated 10-char code', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: '10% Off',
      discount_type: 'percentage', discount_value: 10,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    assertEq(v.code.length, 10);
    assertEq(v.status, 'active');
  });

  await test('T06: createVoucher with custom code', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: 'Bangkok Sale', code: 'BKKSALE50',
      discount_type: 'fixed', discount_value: 50,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    assertEq(v.code, 'BKKSALE50');
  });

  // === validate ===
  await test('T07: validate rejects unknown code', async () => {
    const r = await engine.validate({ code: 'NOPE123456' });
    assertEq(r.valid, false);
    assertEq(r.reason, 'INVALID_CODE');
  });

  await test('T08: validate returns valid for active voucher', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: '20% Off', discount_type: 'percentage', discount_value: 20,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    const r = await engine.validate({ code: v.code, purchase_amount: 1000 });
    assertEq(r.valid, true);
    assertEq(r.calculated_discount, 200); // 20% of 1000
    assertEq(r.final_amount, 800);
  });

  await test('T09: validate rejects expired voucher', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: 'Expired', discount_type: 'fixed', discount_value: 10,
      valid_from: new Date(Date.now() - 2 * 86400000).toISOString(),
      valid_until: new Date(Date.now() - 86400000).toISOString(), // yesterday
    });
    const r = await engine.validate({ code: v.code });
    assertEq(r.valid, false);
    assertEq(r.reason, 'EXPIRED');
  });

  await test('T10: validate rejects not-yet-started voucher', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: 'Future', discount_type: 'fixed', discount_value: 10,
      valid_from: new Date(Date.now() + 86400000).toISOString(),
      valid_until: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    const r = await engine.validate({ code: v.code });
    assertEq(r.reason, 'NOT_STARTED');
  });

  await test('T11: validate enforces min_purchase', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: 'Min500', discount_type: 'fixed', discount_value: 50,
      min_purchase: 500,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    const r = await engine.validate({ code: v.code, purchase_amount: 100 });
    assertEq(r.reason, 'MIN_PURCHASE_NOT_MET');
  });

  await test('T12: validate enforces per_user_limit', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: '1PerUser', discount_type: 'fixed', discount_value: 10,
      per_user_limit: 1, total_quantity: 100,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    // First use OK
    await engine.redeem({ code: v.code, member_id: 'M-1', purchase_amount: 1000 });
    // Second use should fail
    const r = await engine.validate({ code: v.code, member_id: 'M-1', purchase_amount: 1000 });
    assertEq(r.reason, 'PER_USER_LIMIT_REACHED');
  });

  // === redeem ===
  await test('T13: redeem percentage discount', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: '15% Off', discount_type: 'percentage', discount_value: 15,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    const r = await engine.redeem({ code: v.code, member_id: 'M-1', purchase_amount: 2000 });
    assertEq(r.discount_amount, 300);
    assertEq(r.final_amount, 1700);
  });

  await test('T14: redeem fixed discount', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: '฿100 Off', discount_type: 'fixed', discount_value: 100,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    const r = await engine.redeem({ code: v.code, member_id: 'M-1', purchase_amount: 500 });
    assertEq(r.discount_amount, 100);
    assertEq(r.final_amount, 400);
  });

  await test('T15: redeem caps by max_discount', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: '50% Max100', discount_type: 'percentage', discount_value: 50,
      max_discount: 100,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    const r = await engine.redeem({ code: v.code, member_id: 'M-1', purchase_amount: 1000 });
    assertEq(r.discount_amount, 100); // capped from 500
  });

  await test('T16: redeem increments count + exhausts', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: '3Only', discount_type: 'fixed', discount_value: 10,
      total_quantity: 3, per_user_limit: 1,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    await engine.redeem({ code: v.code, member_id: 'M-1', purchase_amount: 100 });
    await engine.redeem({ code: v.code, member_id: 'M-2', purchase_amount: 100 });
    // Add 3rd member to test exhaust (not per_user_limit)
    engine.members._members['M-3'] = { member_id: 'M-3' };
    await engine.redeem({ code: v.code, member_id: 'M-3', purchase_amount: 100 });
    assertEq(v.redeemed_count, 3);
    assertEq(v.status, 'exhausted');
  });

  await test('T17: redeem rejects exhausted voucher', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: '1Only', discount_type: 'fixed', discount_value: 10,
      total_quantity: 1,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    await engine.redeem({ code: v.code, member_id: 'M-1', purchase_amount: 100 });
    try { await engine.redeem({ code: v.code, member_id: 'M-2', purchase_amount: 100 }); assert(false); }
    catch (e) { assertContains(e.message, 'invalid', 'wrong error'); }
  });

  // === void ===
  await test('T18: voidVoucher cancels unredeemed', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: 'Cancel Me', discount_type: 'fixed', discount_value: 10,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    const r = await engine.voidVoucher({ voucher_id: v.voucher_id, reason: 'wrong_price' });
    assertEq(r.status, 'expired');
  });

  await test('T19: voidVoucher rejects voucher with redemptions', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: 'Used', discount_type: 'fixed', discount_value: 10,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    await engine.redeem({ code: v.code, member_id: 'M-1', purchase_amount: 100 });
    try { await engine.voidVoucher({ voucher_id: v.voucher_id, reason: 'test' }); assert(false); }
    catch (e) { assertContains(e.message, 'redemptions', 'wrong error'); }
  });

  // === List / Stats ===
  await test('T20: listVouchers filters by merchant', async () => {
    const r = await engine.listVouchers({ merchant_id: 'MCH-1' });
    assert(r.items.every((v) => v.merchant_id === 'MCH-1'));
  });

  await test('T21: listRedemptions filters by voucher', async () => {
    const r = await engine.listRedemptions({ voucher_id: 'NONEXIST' });
    assertEq(r.total, 0);
  });

  await test('T22: getStats aggregates sales + discount', async () => {
    const s = await engine.getStats({});
    assert(s.total_vouchers > 0);
    assert(s.redemptions > 0);
  });

  await test('T23: createVoucher publishes event', async () => {
    const before = engine.bus._e.filter((e) => e.t === 'voucher.created').length;
    await engine.createVoucher({
      merchant_id: 'MCH-1', name: 'EventTest', discount_type: 'fixed', discount_value: 10,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    const after = engine.bus._e.filter((e) => e.t === 'voucher.created').length;
    assert(after > before);
  });

  await test('T24: redeem publishes voucher.redeemed event', async () => {
    const v = await engine.createVoucher({
      merchant_id: 'MCH-1', name: 'RedeemEvent', discount_type: 'fixed', discount_value: 10,
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 86400000).toISOString(),
    });
    const before = engine.bus._e.filter((e) => e.t === 'voucher.redeemed').length;
    await engine.redeem({ code: v.code, member_id: 'M-1', purchase_amount: 100 });
    const after = engine.bus._e.filter((e) => e.t === 'voucher.redeemed').length;
    assert(after > before);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
