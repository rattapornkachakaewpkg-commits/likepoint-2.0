// I18n Engine — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { I18nEngine } = require('./i18n-engine.js');

function makeMembers() {
  return {
    _members: { 'M-1': { member_id: 'M-1', preferred_locale: 'th' } },
    async get(id) { return this._members[id] || null; },
    async update(id, updates) { if (this._members[id]) Object.assign(this._members[id], updates); return this._members[id]; },
  };
}
function makeAudit() { return { _l: [], async log(e) { this._l.push(e); return { id: 'a' }; } }; }

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n🌍 I18n Engine — Tests\n');

(async () => {
  const members = makeMembers();
  const audit = makeAudit();
  const engine = new I18nEngine({ memberService: members, auditEngine: audit });

  // === setTranslation ===
  await test('T01: setTranslation requires key and translations', async () => {
    try { await engine.setTranslation({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: setTranslation rejects unsupported locale', async () => {
    try { await engine.setTranslation({ key: 'k', translations: { xx: 'hi' } }); assert(false); }
    catch (e) { assertContains(e.message, 'Unsupported', 'wrong error'); }
  });

  await test('T03: setTranslation requires default locale (th)', async () => {
    try { await engine.setTranslation({ key: 'k', translations: { en: 'hello' } }); assert(false); }
    catch (e) { assertContains(e.message, 'default locale', 'wrong error'); }
  });

  await test('T04: setTranslation with 4 locales', async () => {
    const r = await engine.setTranslation({
      key: 'greeting.hello',
      translations: { th: 'สวัสดี', en: 'Hello', kh: 'ជំរាបសួស', la: 'ສະບາຍດີ' },
    });
    assertEq(r.translations.en, 'Hello');
  });

  // === getTranslation ===
  await test('T05: getTranslation returns key as fallback for missing translation', async () => {
    assertEq(engine.getTranslation({ key: 'nonexistent' }), 'nonexistent');
  });

  await test('T06: getTranslation returns localized text', async () => {
    assertEq(engine.getTranslation({ key: 'greeting.hello', locale: 'th' }), 'สวัสดี');
    assertEq(engine.getTranslation({ key: 'greeting.hello', locale: 'en' }), 'Hello');
    assertEq(engine.getTranslation({ key: 'greeting.hello', locale: 'kh' }), 'ជំរាបសួស');
    assertEq(engine.getTranslation({ key: 'greeting.hello', locale: 'la' }), 'ສະບາຍດີ');
  });

  await test('T07: getTranslation substitutes variables', async () => {
    await engine.setTranslation({ key: 'greeting.welcome', translations: { th: 'สวัสดี {{name}}', en: 'Welcome {{name}}' } });
    const r = engine.getTranslation({ key: 'greeting.welcome', locale: 'en', variables: { name: 'Alice' } });
    assertContains(r, 'Alice');
  });

  await test('T08: getTranslation falls back to default locale', async () => {
    await engine.setTranslation({ key: 'fallback.test', translations: { th: 'เทส' } });
    assertEq(engine.getTranslation({ key: 'fallback.test', locale: 'kh' }), 'เทส');
  });

  await test('T09: getTranslation supports 4 locales (th/en/kh/la)', async () => {
    assertEq(engine.supportedLocales.length, 4);
    assert(engine.supportedLocales.includes('th'));
    assert(engine.supportedLocales.includes('en'));
    assert(engine.supportedLocales.includes('kh'));
    assert(engine.supportedLocales.includes('la'));
  });

  // === setMemberLocale ===
  await test('T10: setMemberLocale updates member preference', async () => {
    await engine.setMemberLocale({ member_id: 'M-1', locale: 'en' });
    assertEq(members._members['M-1'].preferred_locale, 'en');
  });

  await test('T11: setMemberLocale rejects unsupported locale', async () => {
    try { await engine.setMemberLocale({ member_id: 'M-1', locale: 'jp' }); assert(false); }
    catch (e) { assertContains(e.message, 'Unsupported', 'wrong error'); }
  });

  await test('T12: getMemberLocale returns default if not set', async () => {
    const r = await engine.getMemberLocale({ member_id: 'M-2' });
    assertEq(r, 'th');
  });

  // === formatNumber / formatCurrency / formatDate ===
  await test('T13: formatNumber per locale', async () => {
    const th = engine.formatNumber({ value: 1234.5, locale: 'th' });
    const en = engine.formatNumber({ value: 1234.5, locale: 'en' });
    assert(th.includes('1,234.50') || th.includes('1,234'));
    assert(en.includes('1,234.50') || en.includes('1,234'));
  });

  await test('T14: formatCurrency with THB/USD/KHR', async () => {
    const thb = engine.formatCurrency({ value: 100, currency: 'THB' });
    const usd = engine.formatCurrency({ value: 100, currency: 'USD' });
    assertContains(thb, '฿');
    assertContains(usd, '$');
  });

  await test('T15: formatDate per locale', async () => {
    const d = '2026-07-07T10:00:00Z';
    const th = engine.formatDate({ date: d, locale: 'th' });
    const en = engine.formatDate({ date: d, locale: 'en' });
    // Both should contain day 7
    assertContains(th, '7');
    assertContains(en, '7');
  });

  // === listTranslations ===
  await test('T16: listTranslations returns all', async () => {
    const r = engine.listTranslations({});
    assert(r.total > 0);
  });

  await test('T17: listTranslations filters by locale', async () => {
    const r = engine.listTranslations({ locale: 'en' });
    assert(r.items.every((i) => i.translations.en));
  });

  // === getStats ===
  await test('T18: getStats counts coverage by locale', async () => {
    const s = engine.getStats();
    assert(s.total_translations > 0);
    assert(s.by_locale.th > 0);
    assert(s.by_locale.en > 0);
  });

  await test('T19: getTranslation handles invalid input gracefully', async () => {
    try { engine.getTranslation({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
