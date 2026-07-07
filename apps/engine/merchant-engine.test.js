// Merchant Engine — Unit Tests
// Tests: 24 cases covering white-label isolation, KYC, tier limits, POI rules, audit
// Author: AliClaw | Date: 2026-07-07

const { MerchantEngine } = require('./merchant-engine.js');

// --- Mocks ---
function makeAudit() {
  return {
    _log: [],
    async log(entry) { this._log.push(entry); return { id: `AUD-${this._log.length}`, created_at: new Date().toISOString() }; },
    list() { return this._log; },
  };
}
function makeBus() {
  return {
    _events: [],
    async publish(topic, payload) { this._events.push({ topic, payload, at: new Date().toISOString() }); },
    getEvents(topic) { return this._events.filter((e) => e.topic === topic); },
  };
}
function makeKyc(decision = 'approved') {
  return {
    async verify(docs) { return { status: decision, reason: decision === 'rejected' ? 'invalid doc' : null }; },
  };
}

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const assertEq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const assertContains = (s, sub, msg) => { if (!s.includes(sub)) throw new Error(`${msg || 'contains'}: "${sub}" not in "${s.slice(0, 100)}"`); };

// ============================================================
console.log('\n🏢 Merchant Engine — Tests\n');

(async () => {
  const audit = makeAudit();
  const bus = makeBus();
  const kyc = makeKyc('approved');
  const engine = new MerchantEngine({ auditEngine: audit, eventBus: bus, kycService: kyc });

  // --- Validation ---
  await test('T01: onboard requires business_name, email, country', async () => {
    try { await engine.onboardMerchant({}); assert(false, 'should throw'); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: onboard rejects invalid email', async () => {
    try { await engine.onboardMerchant({ business_name: 'X', contact_email: 'not-email', country: 'TH' }); assert(false); }
    catch (e) { assertContains(e.message, 'email', 'wrong error'); }
  });

  await test('T03: onboard rejects invalid country code', async () => {
    try { await engine.onboardMerchant({ business_name: 'X', contact_email: 'x@y.com', country: 'THA' }); assert(false); }
    catch (e) { assertContains(e.message, 'country', 'wrong error'); }
  });

  await test('T04: onboard rejects invalid tier', async () => {
    try { await engine.onboardMerchant({ business_name: 'X', contact_email: 'x@y.com', country: 'TH', tier: 'gold' }); assert(false); }
    catch (e) { assertContains(e.message, 'tier', 'wrong error'); }
  });

  // --- Onboarding happy path ---
  await test('T05: starter tier onboard (no KYC required)', async () => {
    const r = await engine.onboardMerchant({
      business_name: 'Bangkok Cafe', contact_email: 'cafe@x.com', country: 'TH', tier: 'starter',
    });
    assertEq(r.tier, 'starter');
    assertEq(r.kyc_status, 'not_required');
    assert(r.api_key.startsWith('mk_live_'), 'API key format');
    assertEq(r.business_name, 'Bangkok Cafe');
  });

  await test('T06: pro tier requires KYC docs', async () => {
    try { await engine.onboardMerchant({ business_name: 'Y', contact_email: 'y@z.com', country: 'TH', tier: 'pro' }); assert(false); }
    catch (e) { assertContains(e.message, 'KYC', 'wrong error'); }
  });

  await test('T07: pro tier with KYC approved', async () => {
    const r = await engine.onboardMerchant({
      business_name: 'PKG Corp', contact_email: 'pkg@pkg.com', country: 'TH', tier: 'pro',
      kyc_docs: { business_license: 'BL-001', tax_id: 'TAX-001' },
    });
    assertEq(r.kyc_status, 'approved');
  });

  await test('T08: duplicate business_name in same country rejected', async () => {
    try { await engine.onboardMerchant({ business_name: 'Bangkok Cafe', contact_email: 'b@y.com', country: 'TH', tier: 'starter' }); assert(false); }
    catch (e) { assertContains(e.message, 'already exists', 'wrong error'); }
  });

  await test('T09: same name in different country allowed', async () => {
    const r = await engine.onboardMerchant({
      business_name: 'Bangkok Cafe', contact_email: 'bkk@kh.com', country: 'KH', tier: 'starter',
    });
    assert(r.merchant_id.startsWith('MCH-'), 'merchant_id format');
  });

  // --- Audit + event ---
  await test('T10: onboard publishes merchant.onboarded event', async () => {
    const events = bus.getEvents('merchant.onboarded');
    assert(events.length >= 1, 'should have event');
  });

  await test('T11: onboard audits itself', async () => {
    const logs = audit.list().filter((l) => l.event_type === 'MERCHANT_ONBOARDED');
    assert(logs.length >= 1, 'should have audit log');
  });

  // --- Token creation ---
  await test('T12: createToken on starter merchant', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe A', contact_email: 'a@a.com', country: 'VN', tier: 'starter' });
    const t = await engine.createToken({ merchant_id: m.merchant_id, name: 'Cafe A Point', symbol: 'CAP' });
    assertEq(t.symbol, 'CAP');
    assertEq(t.merchant_id, m.merchant_id);
  });

  await test('T13: createToken rejects duplicate symbol per merchant', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe B', contact_email: 'b@b.com', country: 'LA', tier: 'starter' });
    await engine.createToken({ merchant_id: m.merchant_id, name: 'B Point', symbol: 'BP' });
    try { await engine.createToken({ merchant_id: m.merchant_id, name: 'B Point 2', symbol: 'BP' }); assert(false); }
    catch (e) { assertContains(e.message, 'already used', 'wrong error'); }
  });

  await test('T14: same symbol across different merchants allowed', async () => {
    const m1 = await engine.onboardMerchant({ business_name: 'Cafe C1', contact_email: 'c1@c.com', country: 'MM', tier: 'starter' });
    const m2 = await engine.onboardMerchant({ business_name: 'Cafe C2', contact_email: 'c2@c.com', country: 'MM', tier: 'starter' });
    const t1 = await engine.createToken({ merchant_id: m1.merchant_id, name: 'C Point', symbol: 'CP' });
    const t2 = await engine.createToken({ merchant_id: m2.merchant_id, name: 'C Point', symbol: 'CP' });
    assert(t1.token_id !== t2.token_id, 'different tokens');
  });

  await test('T15: starter tier limited to 1 token', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe D', contact_email: 'd@d.com', country: 'KH', tier: 'starter' });
    await engine.createToken({ merchant_id: m.merchant_id, name: 'D Point', symbol: 'DP' });
    try { await engine.createToken({ merchant_id: m.merchant_id, name: 'D Point 2', symbol: 'DP2' }); assert(false); }
    catch (e) { assertContains(e.message, 'limit', 'wrong error');
    }
  });

  await test('T16: pro tier allows up to 5 tokens', async () => {
    const m = await engine.onboardMerchant({
      business_name: 'Pro Cafe', contact_email: 'pro@p.com', country: 'TH', tier: 'pro',
      kyc_docs: { license: 'L1' },
    });
    for (let i = 1; i <= 5; i++) {
      await engine.createToken({ merchant_id: m.merchant_id, name: `Token ${i}`, symbol: `T${i}` });
    }
    assertEq(Array.from(engine.tokens.values()).filter((t) => t.merchant_id === m.merchant_id).length, 5);
  });

  await test('T17: createToken rejects invalid decimals', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe E', contact_email: 'e@e.com', country: 'JP', tier: 'starter' });
    try { await engine.createToken({ merchant_id: m.merchant_id, name: 'E', symbol: 'E', decimals: 19 }); assert(false); }
    catch (e) { assertContains(e.message, 'decimals', 'wrong error'); }
  });

  await test('T18: createToken rejects invalid peg_currency', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe F', contact_email: 'f@f.com', country: 'SG', tier: 'starter' });
    try { await engine.createToken({ merchant_id: m.merchant_id, name: 'F', symbol: 'F', peg_currency: 'thb' }); assert(false); }
    catch (e) { assertContains(e.message, 'ISO-4217', 'wrong error'); }
  });

  // --- Mint ---
  await test('T19: mintTokens increases total_supply', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe G', contact_email: 'g@g.com', country: 'MY', tier: 'starter' });
    const t = await engine.createToken({ merchant_id: m.merchant_id, name: 'G Point', symbol: 'GP' });
    const r = await engine.mintTokens({ merchant_id: m.merchant_id, token_id: t.token_id, amount: 1000 });
    assertEq(r.new_total_supply, 1000);
    assertEq(engine.tokens.get(t.token_id).total_supply, 1000);
  });

  await test('T20: mintTokens rejects amount > tier cap', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe H', contact_email: 'h@h.com', country: 'ID', tier: 'starter' });
    const t = await engine.createToken({ merchant_id: m.merchant_id, name: 'H Point', symbol: 'HP' });
    try { await engine.mintTokens({ merchant_id: m.merchant_id, token_id: t.token_id, amount: 20000 }); assert(false); }
    catch (e) { assertContains(e.message, 'cap', 'wrong error'); }
  });

  await test('T21: large mint requires KYC approval', async () => {
    const m = await engine.onboardMerchant({
      business_name: 'Cafe I', contact_email: 'i@i.com', country: 'TH', tier: 'pro',
      kyc_docs: { license: 'L2' },
    });
    const t = await engine.createToken({ merchant_id: m.merchant_id, name: 'I Point', symbol: 'IP' });
    const r = await engine.mintTokens({ merchant_id: m.merchant_id, token_id: t.token_id, amount: 200000 });
    assertEq(r.amount, 200000);
  });

  await test('T22: mintTokens cross-merchant blocked', async () => {
    const m1 = await engine.onboardMerchant({ business_name: 'Cafe J1', contact_email: 'j1@j.com', country: 'PH', tier: 'starter' });
    const m2 = await engine.onboardMerchant({ business_name: 'Cafe J2', contact_email: 'j2@j.com', country: 'PH', tier: 'starter' });
    const t = await engine.createToken({ merchant_id: m1.merchant_id, name: 'J Point', symbol: 'JP' });
    try { await engine.mintTokens({ merchant_id: m2.merchant_id, token_id: t.token_id, amount: 100 }); assert(false); }
    catch (e) { assertContains(e.message, 'does not belong', 'wrong error'); }
  });

  // --- POI rules ---
  await test('T23: setPOIRules validates event_type', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe K', contact_email: 'k@k.com', country: 'TH', tier: 'starter' });
    const t = await engine.createToken({ merchant_id: m.merchant_id, name: 'K Point', symbol: 'KP' });
    try { await engine.setPOIRules({ merchant_id: m.merchant_id, token_id: t.token_id, rules: [{ event_type: 'invalid' }] }); assert(false); }
    catch (e) { assertContains(e.message, 'event_type', 'wrong error'); }
  });

  await test('T24: setPOIRules sets multiple rules', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe L', contact_email: 'l@l.com', country: 'TH', tier: 'starter' });
    const t = await engine.createToken({ merchant_id: m.merchant_id, name: 'L Point', symbol: 'LP' });
    const r = await engine.setPOIRules({
      merchant_id: m.merchant_id, token_id: t.token_id,
      rules: [
        { event_type: 'daily_login', reward_amount: 100, reward_type: 'fixed', cooldown: 'PT24H' },
        { event_type: 'referral', reward_amount: 500, reward_type: 'fixed', cooldown: 'P7D' },
      ],
    });
    assertEq(r.count, 2);
  });

  await test('T25: getStats returns aggregated metrics', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe M', contact_email: 'm@m.com', country: 'TH', tier: 'starter' });
    const t = await engine.createToken({ merchant_id: m.merchant_id, name: 'M Point', symbol: 'MP' });
    await engine.mintTokens({ merchant_id: m.merchant_id, token_id: t.token_id, amount: 500 });
    await engine.setPOIRules({ merchant_id: m.merchant_id, token_id: t.token_id, rules: [{ event_type: 'daily_login', reward_amount: 10, reward_type: 'fixed' }] });
    const stats = await engine.getStats({ merchant_id: m.merchant_id });
    assertEq(stats.token_count, 1);
    assertEq(stats.total_supply, 500);
    assertEq(stats.poi_rule_count, 1);
  });

  // --- List ---
  await test('T26: listMerchants filters by tier', async () => {
    const r = await engine.listMerchants({ tier: 'starter' });
    assert(r.items.every((m) => m.tier === 'starter'), 'all should be starter');
    assert(r.total >= 5, 'should have >=5 starter merchants');
  });

  await test('T27: listTokens filters by merchant', async () => {
    const m = await engine.onboardMerchant({ business_name: 'Cafe N', contact_email: 'n@n.com', country: 'TH', tier: 'starter' });
    const t = await engine.createToken({ merchant_id: m.merchant_id, name: 'N Point', symbol: 'NP' });
    const r = await engine.listTokens({ merchant_id: m.merchant_id });
    assertEq(r.items.length, 1);
    assertEq(r.items[0].token_id, t.token_id);
  });

  // --- KYC rejection ---
  await test('T28: KYC rejected throws', async () => {
    const kycBad = makeKyc('rejected');
    const e2 = new MerchantEngine({ auditEngine: audit, eventBus: bus, kycService: kycBad });
    try { await e2.onboardMerchant({ business_name: 'Bad Co', contact_email: 'b@b.com', country: 'TH', tier: 'pro', kyc_docs: {} }); assert(false); }
    catch (err) { assertContains(err.message, 'KYC rejected', 'wrong error'); }
  });

  // --- Summary ---
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
