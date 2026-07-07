// Multi-language (i18n) Engine — PF-18 (Phase E)
// Locale switching + translation + locale-specific formatting
// Supports: th (default), en, kh (Cambodian), la (Lao)
// Based on Likepoint meeting 12/01/2023: 4 locales
// Author: AliClaw | Date: 2026-07-07

class I18nEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.translationStore - in-memory translations (replace DB in prod)
   * @param {Object} deps.memberService - get member's preferred locale
   * @param {Object} deps.auditEngine
   */
  constructor({ translationStore, memberService, auditEngine } = {}) {
    this.translations = translationStore || new Map(); // key -> { th, en, kh, la }
    this.members = memberService || { get: async () => null, update: async () => null };
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.defaultLocale = 'th';
    this.supportedLocales = ['th', 'en', 'kh', 'la'];
  }

  // ============================================================
  // 1. setTranslation() — admin adds translation
  // ============================================================
  async setTranslation({ key, translations, actor = 'admin' }) {
    if (!key || !translations) throw new Error('key, translations are required');
    const valid = {};
    for (const [loc, val] of Object.entries(translations)) {
      if (!this.supportedLocales.includes(loc)) throw new Error(`Unsupported locale: ${loc}`);
      if (typeof val !== 'string') throw new Error(`Translation for ${loc} must be string`);
      valid[loc] = val;
    }
    // Ensure default locale present
    if (!valid[this.defaultLocale]) throw new Error(`Translation for default locale (${this.defaultLocale}) required`);
    this.translations.set(key, valid);
    await this.audit.log({
      event_type: 'I18N_TRANSLATION_SET', actor,
      resource_type: 'translation', resource_id: key,
      action: 'CREATE', metadata: { locales: Object.keys(valid) },
    });
    return { key, translations: valid };
  }

  // ============================================================
  // 2. getTranslation() — lookup with fallback
  // ============================================================
  getTranslation({ key, locale = this.defaultLocale, variables = {} }) {
    if (!key) throw new Error('key is required');
    if (!this.supportedLocales.includes(locale)) {
      locale = this.defaultLocale;
    }
    const entry = this.translations.get(key);
    if (!entry) return key; // fallback: return key itself
    let text = entry[locale] || entry[this.defaultLocale] || key;
    // Variable substitution: {{name}} → value
    for (const [k, v] of Object.entries(variables)) {
      text = text.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), v);
    }
    return text;
  }

  // ============================================================
  // 3. setMemberLocale() — set user's preferred locale
  // ============================================================
  async setMemberLocale({ member_id, locale }) {
    if (!this.supportedLocales.includes(locale)) throw new Error(`Unsupported locale: ${locale}`);
    return this.members.update?.(member_id, { preferred_locale: locale });
  }

  // ============================================================
  // 4. getMemberLocale() — get user's preferred locale (default: 'th')
  // ============================================================
  async getMemberLocale({ member_id }) {
    if (!member_id) return this.defaultLocale;
    const member = await this.members.get?.(member_id);
    return member?.preferred_locale || this.defaultLocale;
  }

  // ============================================================
  // 5. formatNumber() — locale-specific number formatting
  // ============================================================
  formatNumber({ value, locale = this.defaultLocale, decimals = 2 }) {
    if (typeof value !== 'number' || isNaN(value)) return String(value);
    const formatters = {
      th: new Intl.NumberFormat('th-TH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
      en: new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
      kh: new Intl.NumberFormat('km-KH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
      la: new Intl.NumberFormat('lo-LA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
    };
    const fmt = formatters[locale] || formatters[this.defaultLocale];
    return fmt.format(value);
  }

  // ============================================================
  // 6. formatCurrency() — currency with symbol
  // ============================================================
  formatCurrency({ value, currency, locale = this.defaultLocale }) {
    if (typeof value !== 'number' || isNaN(value)) return String(value);
    const cur = currency || (locale === 'th' ? 'THB' : locale === 'kh' ? 'KHR' : locale === 'la' ? 'LAK' : 'USD');
    try {
      return new Intl.NumberFormat(`${locale}-${this._countryForLocale(locale)}`, {
        style: 'currency', currency: cur,
      }).format(value);
    } catch (e) {
      return `${cur} ${value.toFixed(2)}`;
    }
  }

  // ============================================================
  // 7. formatDate() — locale-specific date
  // ============================================================
  formatDate({ date, locale = this.defaultLocale, includeTime = false }) {
    const d = date ? new Date(date) : new Date();
    if (isNaN(d.getTime())) return String(date);
    const options = includeTime
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
    const locales = { th: 'th-TH', en: 'en-US', kh: 'km-KH', la: 'lo-LA' };
    try {
      return new Intl.DateTimeFormat(locales[locale] || 'en-US', options).format(d);
    } catch (e) {
      return d.toISOString();
    }
  }

  // ============================================================
  // 8. listTranslations() — for admin/editor
  // ============================================================
  listTranslations({ locale, limit = 100 } = {}) {
    let all = Array.from(this.translations.entries());
    if (locale) all = all.filter(([_, v]) => v[locale]);
    return { total: all.length, items: all.slice(0, limit).map(([k, v]) => ({ key: k, translations: v })) };
  }

  // ============================================================
  // 9. getStats() — coverage by locale
  // ============================================================
  getStats() {
    const total = this.translations.size;
    const byLocale = {};
    for (const loc of this.supportedLocales) byLocale[loc] = 0;
    for (const v of this.translations.values()) {
      for (const loc of this.supportedLocales) {
        if (v[loc]) byLocale[loc]++;
      }
    }
    return { total_translations: total, by_locale: byLocale };
  }

  // ============================================================
  // private
  // ============================================================
  _countryForLocale(locale) {
    return { th: 'TH', en: 'US', kh: 'KH', la: 'LA' }[locale] || 'US';
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { I18nEngine };
}
if (typeof window !== 'undefined') {
  window.I18nEngine = I18nEngine;
}
