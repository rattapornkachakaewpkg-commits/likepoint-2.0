// FX Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { FXEngine } = require('./fx-engine.js');

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };
const assertApprox = (a, b, m, eps = 0.01) => { if (Math.abs(a - b) > eps) throw new Error(`${m}: expected ~${b}, got ${a}`); };

console.log('\n💱 FX Engine — Tests\n');

(async () => {
  const engine = new FXEngine();

  // === setCountryCurrency ===
  await test('T01: setCountryCurrency requires country_code and currency_code', async () => {
    try { await engine.setCountryCurrency({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: setCountryCurrency validates ISO codes', async () => {
    try { await engine.setCountryCurrency({ country_code: 'THA', currency_code: 'THB' }); assert(false); }
    catch (e) { assertContains(e.message, 'country_code', 'wrong error'); }
  });

  await test('T03: setCountryCurrency TH → THB', async () => {
    const r = await engine.setCountryCurrency({ country_code: 'TH', currency_code: 'THB', currency_name: 'Thai Baht' });
    assertEq(r.currency_code, 'THB');
  });

  await test('T04: setCountryCurrency KH → KHR', async () => {
    const r = await engine.setCountryCurrency({ country_code: 'KH', currency_code: 'KHR', currency_name: 'Cambodian Riel' });
    assertEq(r.country_code, 'KH');
  });

  // === setFXRate ===
  await test('T05: setFXRate validates rate > 0', async () => {
    try { await engine.setFXRate({ from_currency: 'THB', to_currency: 'USD', rate: -1 }); assert(false); }
    catch (e) { assertContains(e.message, 'positive', 'wrong error'); }
  });

  await test('T06: setFXRate same currency must be 1', async () => {
    try { await engine.setFXRate({ from_currency: 'THB', to_currency: 'THB', rate: 2 }); assert(false); }
    catch (e) { assertContains(e.message, 'rate 1', 'wrong error'); }
  });

  await test('T07: setFXRate THB → USD = 0.027', async () => {
    const r = await engine.setFXRate({ from_currency: 'THB', to_currency: 'USD', rate: 0.027 });
    assertApprox(r.rate, 0.027, 'rate', 0.001);
  });

  await test('T08: setFXRate USD → THB = 37', async () => {
    const r = await engine.setFXRate({ from_currency: 'USD', to_currency: 'THB', rate: 37 });
    assertEq(r.rate, 37);
  });

  await test('T09: setFXRate THB → KHR = 125 (1 THB ≈ 125 KHR)', async () => {
    const r = await engine.setFXRate({ from_currency: 'THB', to_currency: 'KHR', rate: 125 });
    assertEq(r.rate, 125);
  });

  // === convert ===
  await test('T10: convert same currency returns 1:1', async () => {
    const r = await engine.convert({ amount: 100, from_currency: 'THB', to_currency: 'THB' });
    assertEq(r.rate, 1);
    assertEq(r.converted, 100);
    assertEq(r.source, 'identity');
  });

  await test('T11: convert direct rate (THB → USD)', async () => {
    const r = await engine.convert({ amount: 1000, from_currency: 'THB', to_currency: 'USD' });
    assertEq(r.source, 'direct');
    assertApprox(r.converted, 27, '1000 THB ≈ 27 USD', 0.5);
  });

  await test('T12: convert inverse rate (USD → THB)', async () => {
    const r = await engine.convert({ amount: 10, from_currency: 'USD', to_currency: 'THB' });
    assertEq(r.source, 'direct');
    assertEq(r.converted, 370);
  });

  await test('T13: convert triangulated rate (USD → KHR via THB)', async () => {
    const r = await engine.convert({ amount: 1, from_currency: 'USD', to_currency: 'KHR' });
    assertContains(r.source, 'triangulated', 'should triangulate');
    // 1 USD = 37 THB = 37 × 125 = 4,625 KHR
    assertApprox(r.converted, 4625, '1 USD ≈ 4,625 KHR', 5);
  });

  await test('T14: convert throws when no rate available', async () => {
    try { await engine.convert({ amount: 100, from_currency: 'EUR', to_currency: 'JPY' }); assert(false); }
    catch (e) { assertContains(e.message, 'No FX rate', 'wrong error'); }
  });

  // === convertTokenPeg ===
  await test('T15: convertTokenPeg same currency (BCP → THB)', async () => {
    // 100 BCP pegged at 0.01 THB/token = 1 THB
    const r = await engine.convertTokenPeg({ amount: 100, token_peg_currency: 'THB', token_peg_rate: 0.01, target_currency: 'THB' });
    assertEq(r.peg_value, 1);
    assertEq(r.final_value, 1);
  });

  await test('T16: convertTokenPeg cross-currency (BCP → USD)', async () => {
    // 1000 BCP @ 0.01 THB = 10 THB → 10 × 0.027 = 0.27 USD
    const r = await engine.convertTokenPeg({ amount: 1000, token_peg_currency: 'THB', token_peg_rate: 0.01, target_currency: 'USD' });
    assertEq(r.peg_value, 10);
    assertApprox(r.final_value, 0.27, 'should be 0.27 USD', 0.01);
  });

  // === getCountryCurrency ===
  await test('T17: getCountryCurrency returns registered', async () => {
    const r = await engine.getCountryCurrency('TH');
    assertEq(r.currency_code, 'THB');
  });

  await test('T18: getCountryCurrency throws for unregistered', async () => {
    try { await engine.getCountryCurrency('XX'); assert(false); }
    catch (e) { assertContains(e.message, 'not registered', 'wrong error'); }
  });

  // === getRate ===
  await test('T19: getRate returns current rate', async () => {
    const r = await engine.getRate({ from_currency: 'USD', to_currency: 'KHR' });
    assertApprox(r.rate, 4625, '1 USD = 4,625 KHR', 5);
  });

  // === refreshFromProvider ===
  await test('T20: refreshFromProvider updates from external', async () => {
    const provider = { async getRate(from, to) { return from === 'EUR' && to === 'USD' ? 1.1 : null; } };
    const e2 = new FXEngine({ fxProvider: provider });
    const r = await e2.refreshFromProvider({ pairs: [{ from: 'EUR', to: 'USD' }] });
    assertEq(r.updated_count, 1);
  });

  await test('T21: refreshFromProvider continues on failure', async () => {
    const provider = { async getRate(from, to) { throw new Error('provider down'); } };
    const e2 = new FXEngine({ fxProvider: provider });
    const r = await e2.refreshFromProvider({ pairs: [{ from: 'EUR', to: 'USD' }] });
    assertEq(r.updated_count, 0);
  });

  // === listRates / listCountries ===
  await test('T22: listRates filters by source', async () => {
    const r = await engine.listRates({ source: 'manual' });
    assert(r.items.every((i) => i.source === 'manual'));
  });

  await test('T23: listCountries returns all', async () => {
    const r = await engine.listCountries();
    assert(r.total >= 2, 'should have TH and KH');
  });

  // === computeDisplayAmount ===
  await test('T24: computeDisplayAmount for TH viewer', async () => {
    const r = await engine.computeDisplayAmount({
      amount: 1000,
      token_peg_currency: 'THB',
      token_peg_rate: 0.01,
      viewer_country: 'TH',
    });
    assertEq(r.viewer_currency, 'THB');
    assertEq(r.viewer_amount, 10);
    assertContains(r.formatted, 'THB');
  });

  await test('T25: computeDisplayAmount for US viewer (THB → USD)', async () => {
    // Need to register US first
    await engine.setCountryCurrency({ country_code: 'US', currency_code: 'USD', currency_name: 'US Dollar' });
    const r = await engine.computeDisplayAmount({
      amount: 1000,
      token_peg_currency: 'THB',
      token_peg_rate: 0.01,
      viewer_country: 'US',
    });
    assertEq(r.viewer_currency, 'USD');
    assertApprox(r.viewer_amount, 0.27, 'should be 0.27 USD', 0.01);
  });

  // === Validation ===
  await test('T26: convert requires positive amount', async () => {
    try { await engine.convert({ amount: -100, from_currency: 'THB', to_currency: 'USD' }); assert(false); }
    catch (e) { assertContains(e.message, 'non-negative', 'wrong error'); }
  });

  await test('T27: convertTokenPeg computes 1 BCP @ 1 สตางค์ = 0.01 THB', async () => {
    const r = await engine.convertTokenPeg({ amount: 1, token_peg_currency: 'THB', token_peg_rate: 0.01, target_currency: 'THB' });
    assertEq(r.peg_value, 0.01);
  });

  // === Stale rate handling ===
  await test('T28: stale rate falls back or throws (no_stale default)', async () => {
    // Setup an expired rate
    const e2 = new FXEngine();
    const expiredRate = { rate_id: 'old', from_currency: 'SGD', to_currency: 'THB', rate: 25, source: 'manual', effective_at: '2020-01-01T00:00:00Z', expires_at: '2020-12-31T00:00:00Z' };
    e2.rates.set('SGD:THB', expiredRate);
    try { await e2.convert({ amount: 100, from_currency: 'SGD', to_currency: 'THB' }); assert(false, 'should throw on stale rate without fallback'); }
    catch (e) { assertContains(e.message, 'No FX rate', 'wrong error'); }
  });

  await test('T29: use_stale=true returns stale rate', async () => {
    const e2 = new FXEngine();
    e2.rates.set('SGD:THB', { rate_id: 'old', from_currency: 'SGD', to_currency: 'THB', rate: 25, source: 'manual', effective_at: '2020-01-01T00:00:00Z', expires_at: '2020-12-31T00:00:00Z' });
    const r = await e2.convert({ amount: 100, from_currency: 'SGD', to_currency: 'THB', use_stale: true });
    assertEq(r.converted, 2500);
    assertEq(r.source, 'direct');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
