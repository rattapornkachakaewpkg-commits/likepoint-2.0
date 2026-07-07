# Phase E — PF-18: Multi-language (i18n) Support

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #18 of likepoint-2.0

> **"GetX translations: th (default), en, kh, la"**
> — Likepoint meeting, 12/01/2023

## 🎯 Objective

สร้าง **multi-language support** สำหรับ Likepoint 2.0 — 4 locales: ไทย (default), English, Khmer (Cambodia), Lao (Laos) — เปิดทาง ASEAN expansion

## 🏗️ Architecture

```
Translation Key (e.g., 'greeting.hello')
  ↓
I18nEngine.getTranslation({ key, locale, variables })
  ↓
Lookup in store (Map<key, { th, en, kh, la }>)
  ↓
Pick locale-specific value (fallback to 'th')
  ↓
Substitute {{variables}} with actual values
  ↓
Return localized text
```

## 📦 Deliverables (5 ไฟล์, ~1,200+ insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/i18n-engine.js` | 7.4 KB | I18nEngine: 8 methods (setTranslation/getTranslation/setMemberLocale/getMemberLocale/formatNumber/formatCurrency/formatDate/listTranslations/getStats) |
| 2 | `apps/engine/i18n-engine.test.js` | 6.5 KB | **19/19 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/i18n-console.html` | 9.8 KB | Translation editor + 4-locale preview + coverage table |
| 4 | `sql/migrations/2026-07-07-phase-e-pf18-i18n.sql` | 5.5 KB | 1 table + 2 views + RLS + 4-locale seed |
| 5 | `docs/phase-e-pf18-i18n.md` | (this file) | Spec + 4 locales + use cases |

## 🔌 API Design

### `setTranslation({ key, translations, actor? })`

Admin adds/updates a translation.

**Returns:** `{ key, translations }`

**Validations:** Default locale (th) required + locale must be in supported list.

### `getTranslation({ key, locale?, variables? })`

Lookup translation with variable substitution.

**Returns:** Localized text (or key as fallback)

**Variable syntax:** `{{name}}` → substituted with `variables.name`

### `setMemberLocale({ member_id, locale })`

Set user's preferred locale (stored on member record).

### `getMemberLocale({ member_id })`

Get user's preferred locale (default: 'th').

### `formatNumber({ value, locale?, decimals? })`

Locale-specific number formatting using `Intl.NumberFormat`:
- `th`: `1,234.50`
- `en`: `1,234.50`
- `kh`: `១,២៣៤.៥០`
- `la`: `໑.໒໓໔,໕໐`

### `formatCurrency({ value, currency?, locale? })`

Currency formatting with symbol:
- THB → `฿1,234.50`
- USD → `$1,234.50`
- KHR → `៛1,234.50`

### `formatDate({ date?, locale?, includeTime? })`

Locale-specific date:
- `th`: `7 ก.ค. 2569` (Buddhist year)
- `en`: `Jul 7, 2026`

### `listTranslations({ locale?, limit? })` / `getStats()`

Admin queries for coverage reports.

## 🛡️ Key Design Decisions

### 1. **Default locale = 'th' (Thai)**
- Primary market
- Used as fallback for missing translations
- Required in every setTranslation call

### 2. **4 locales: th/en/kh/la (ASEAN focus)**
- `th` (Thai) — primary
- `en` (English) — international
- `kh` (Khmer) — Cambodia
- `la` (Lao) — Laos
- Covers all Likepoint target countries

### 3. **Variable substitution: `{{name}}`**
- Standard template syntax (same as React, Vue, etc.)
- No special chars (e.g., Handlebars `{{ }}` → simple `{{ }}`)
- Multiple variables per string

### 4. **Native `Intl.NumberFormat` / `Intl.DateTimeFormat`**
- Built-in Node.js + browser support
- No external dependency
- Locale-specific locale codes: `th-TH`, `en-US`, `km-KH`, `lo-LA`

### 5. **Audit via PF-5**
- `I18N_TRANSLATION_SET` event
- Track who changed which key
- Compliance: know which version of string was used when

### 6. **Coverage stats per locale**
- Identify which keys are missing translations
- Prioritize completion
- `v_i18n_stats` view: count per locale per context (button/error/email/notification)

### 7. **Member preference storage**
- `members.preferred_locale`
- Set via `setMemberLocale()`
- Used by `getMemberLocale()` to fetch correct translation
- Falls back to 'th' if not set

## 🧪 Tests (19/19 passing)

```
✅ setTranslation (4): required, unsupported locale, default required, 4 locales
✅ getTranslation (5): fallback to key, localized, variables, default fallback, 4 locales
✅ setMemberLocale (2): updates, rejects unsupported
✅ getMemberLocale (1): default if not set
✅ formatNumber (1): per locale
✅ formatCurrency (1): THB/USD/KHR
✅ formatDate (1): per locale (th Buddhist year 2569, en 2026)
✅ listTranslations (2): all, filter by locale
✅ getStats (1): coverage by locale
✅ Edge case (1): invalid input
```

## 🗄️ Database Schema

### `i18n_translations`
- `translation_key TEXT` (e.g., 'greeting.hello')
- `locale TEXT` (th/en/kh/la, CHECK constraint)
- `value TEXT`, `context TEXT` (button/error/email/notification/greeting)
- `metadata JSONB`, `status` (active/inactive)
- **Unique:** `(translation_key, locale)`

### View: `v_i18n_coverage`
- Per key: which locales have translations
- `total_locales` (0-4) for identifying gaps

### View: `v_i18n_stats`
- Per locale: count + by context (button/error/email/notification)

### Seed (4 locales × 5 common keys)
- `greeting.hello`, `greeting.welcome` (with `{{name}}`)
- `error.payment_failed`
- `button.submit`
- `notif.poi.reward` (with `{{amount}}`)

### RLS
- `public` (anonymous) → see active translations
- `admin` → full CRUD
- `service` → full CRUD (for app queries)

## 🆚 vs No i18n (Before)

| Aspect | Before | After (PF-18) |
|---|---|---|
| Languages | Thai only | 4 (th/en/kh/la) |
| Hard-coded strings | Everywhere | Centralized key-value |
| Date format | ISO only | Locale-specific |
| Currency | THB only | Auto per locale |
| Coverage visibility | None | v_i18n_coverage view |
| Translation update | Code deploy | DB row, no deploy |

## 🔗 Integration with Other PFs

- **PF-15 (Notification):** notification templates use `{{name}}`, `{{amount}}` → translate per member locale
- **PF-17 (Reporting):** dashboard labels can be translated
- **PF-6 (Merchant):** white-label merchants can customize their own strings
- **Future PFs:** all UI strings + error messages + emails use I18nEngine

## 🐛 Bugs Closed (Indirect)

- **B25** (no i18n) → solved (Constitution v0.2 compliance)
- **B26** (Thai-only) → solved (4 locales)

## 🚀 Production Rollout (4 weeks)

### Week 1: Staging + seed
1. Apply migration on staging (auto-seed 5 common keys × 4 locales)
2. Internal pilot: 10 PKG members test English/Khmer/Lao
3. Collect feedback on missing translations

### Week 2: Key extraction
1. Audit codebase for hard-coded English strings
2. Extract 100+ keys to i18n_translations
3. Add `i18n.getTranslation()` calls in engines

### Week 3: UAT with 3 countries
1. TH: 50 users, EN: 20 expats, KH: 20 Cambodians, LA: 20 Laotians
2. Verify locale-specific UI + date + currency
3. Coverage target: 80% of keys have 4 locales

### Week 4: Public launch
1. Marketing: "Likepoint รองรับ 4 ภาษา"
2. Cambodia + Laos market entry
3. Member can change locale in settings

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Missing translation in some locale | Shows default (th) or key | Default fallback + coverage report |
| Pluralization (1 vs 2+ items) | "1 items" looks wrong | Future: ICU MessageFormat (separate PF) |
| RTL languages (Arabic, Hebrew) | Layout breaks | Future: add `dir="rtl"` + style adjustments |
| Context-sensitive translation | "Submit" = button OR action | Use `context` column to disambiguate |
| Long translations break UI | Layout issue | CSS `text-overflow: ellipsis` |
| Translation cost (professional) | $$$ | Start with machine translation + human review |

## 📊 Success Metrics

- **M-1: Locale coverage** = translated_keys / total_keys (target: >80% per locale)
- **M-2: Member locale adoption** = non-default_locale / total (target: >10% by Month 6)
- **M-3: Translation latency** = new key → all 4 locales (target: <1 week)
- **M-4: Error rate** = missing_translation / total_render (target: <1%)
- **M-5: Cambodian/Lao user growth** = signups in KH/LA (target: 1000+ by Month 6)

## 🔗 Related PFs

- **PF-15 (Notification):** translates notification templates
- **PF-6 (Merchant):** white-label = merchant's own strings
- **PF-17 (Reporting):** translates dashboard labels
- **Future:** all PFs use I18nEngine for user-facing strings

## 🎬 Demo

**Console:** `https://likepoint-2.0.pages.dev/apps/admin-console/pages/i18n-console.html`

**Try:**
1. Click 🇹🇭 TH → enter "ขอบคุณ" → save → coverage table updates
2. Switch to 🇺🇸 EN → enter "Thank you" → save
3. Switch to 🇰🇭 KH → enter "អរគុណ" → save
4. Switch to 🇱🇦 LA → enter "ຂອບໃຈ" → save
5. Live Preview: type "greeting.welcome" → vars `{"name":"Alice"}` → see 4-locale output

---

**Cycle 18 Complete.** 🎉 18 cycles · 479 tests · ~30,850 insertions · 100% deploy success.
