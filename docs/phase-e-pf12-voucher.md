# Phase E — PF-12: Voucher (Coupon) System

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #12 of likepoint-2.0

> **"Gift Voucher (ส่งให้มีระยะเวลา จำนวน Point ที่กำหนด)"**
> — Likepoint meeting, 16/12/2022

## 🎯 Objective

สร้าง **Voucher System** — merchant-issued coupons with expiry + discount (ส่วนลด) สำหรับโปรโมชั่น — ต่างจาก Gift Card (PF-11) ที่ permanent และ full value

## 🆚 Gift Card (PF-11) vs Voucher (PF-12)

| Feature | Gift Card | Voucher |
|---|---|---|
| **Expiry** | None (permanent) | **Required** |
| **Discount** | None (full value) | **% หรือ fixed** |
| **Who issues** | Anyone (user + merchant) | **Merchant only** |
| **Transfer** | Yes (resend gift) | **No** (locked to recipient) |
| **Code format** | 16-char + 6-digit PIN | **10-char only** |
| **Use case** | ของขวัญ | **ส่วนลด/โปรโมชั่น** |
| **Tax** | Transfer | Discount (revenue impact) |

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  VoucherEngine (PF-12)                                      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │createVoucher()│ │  validate()  │  │  redeem()        │ │
│  │ - % or fixed │  │ - check exp  │  │  - apply disc    │ │
│  │ - min/max    │  │ - check qty  │  │  - record txn    │ │
│  │ - date range │  │ - check min  │  │  - increment     │ │
│  │ - quantity   │  │ - calc disc  │  └──────────────────┘ │
│  └──────────────┘  └──────────────┘  ┌──────────────────┐ │
│  ┌──────────────┐  ┌──────────────┐  │  voidVoucher()   │ │
│  │listVouchers()│ │  getStats()  │  │  - cancel       │ │
│  │listRedemptns│ │              │  └──────────────────┘ │
│  └──────────────┘  └──────────────┘                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌────────┐ ┌────────┐
        │vouchers  │ │voucher_│ │ audit  │
        │ (with    │ │redemp- │ │ (PF-5) │
        │  expiry) │ │ tions  │ │        │
        └──────────┘ └────────┘ └────────┘
```

## 📦 Deliverables (5 ไฟล์, ~1,500+ insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/voucher-engine.js` | 11.6 KB | VoucherEngine: 6 methods (createVoucher/validate/redeem/voidVoucher + 2 list/getStats) |
| 2 | `apps/engine/voucher-engine.test.js` | 12.2 KB | **24/24 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/voucher-console.html` | 14.7 KB | Create + validate + redeem + history |
| 4 | `sql/migrations/2026-07-07-phase-e-pf12-voucher.sql` | 8.4 KB | 2 tables + 2 views + 1 function + RLS |
| 5 | `docs/phase-e-pf12-voucher.md` | (this file) | Spec + use cases + comparison vs Gift Card + rollout |

## 🔌 API Design

### `createVoucher({ merchant_id, name, code?, discount_type, discount_value, min_purchase?, max_discount?, total_quantity?, per_user_limit?, valid_from, valid_until, applicable_token_id?, applicable_products? })`

Issue a new voucher.

**Discount types:**
- `percentage` — 0-100 (e.g., 20% off)
- `fixed` — THB amount (e.g., ฿100 off)

**Returns:** `{ voucher_id, code, discount_type, discount_value, total_quantity, valid_from, valid_until, ... }`

**Validations:**
- `valid_until > valid_from`
- percentage must be 0-100
- merchant must be `active`

### `validate({ code, member_id?, purchase_amount? })`

Check if voucher is usable (no actual redeem).

**Returns:**
- `{ valid: true, calculated_discount, final_amount, ... }` if usable
- `{ valid: false, reason: 'EXPIRED'|'EXHAUSTED'|'NOT_STARTED'|'MIN_PURCHASE_NOT_MET'|'PER_USER_LIMIT_REACHED' }` if not

**Checks:**
- Status = `active`
- Not exhausted
- Within date range
- Per-user limit not reached
- Min purchase met (if specified)
- Calculates discount (capped by `max_discount` if set)

### `redeem({ code, member_id, purchase_amount, actor? })`

Apply discount to a purchase.

**Returns:** `{ redemption_id, code, purchase_amount, discount_amount, final_amount, merchant_id }`

**Side effects:**
- Increments `redeemed_count`
- Auto-pauses if exhausted (`status = 'exhausted'`)
- Audit log + event publish

### `voidVoucher({ voucher_id, reason })`

Cancel unredeemed voucher. Rejects if has any redemptions.

### List / Stats
- `listVouchers({ merchant_id?, status? })`
- `listRedemptions({ voucher_id?, member_id? })`
- `getStats({ merchant_id?, since? })`

## 🛡️ Key Design Decisions

### 1. **2-stage validate + redeem**
- `validate()` for preview (merchant shows "discount = ฿200")
- `redeem()` for actual application (commits + records)
- Allows UX: "Apply voucher" button that previews, then confirms

### 2. **2 discount types: percentage vs fixed**
- `percentage` — typical 10/20/50% off
- `fixed` — "฿100 off orders over ฿500"
- `max_discount` cap for percentage (e.g., 50% off max ฿200)

### 3. **Quantity controls**
- `total_quantity` — total available (campaign-wide limit)
- `per_user_limit` — per-customer limit (prevent abuse)
- Auto-pause when exhausted (no manual work)

### 4. **Time-window mandatory (vs Gift Card permanent)**
- `valid_from` + `valid_until` required
- Use cases: Black Friday, weekend sale, campaign-specific
- Auto-expire via cron check or `display_status` view

### 5. **Min purchase + applicable products**
- `min_purchase` — require minimum basket size
- `applicable_token_id` / `applicable_products` — limit to specific items (future)
- Validation enforces both before discount applies

### 6. **Single code, no PIN (vs Gift Card 2-factor)**
- Vouchers are for merchant-controlled scenarios (POS scan, online code entry)
- Trust model: merchant is the verifier
- No need for user-shared secret

### 7. **Audit via PF-5 (4 events)**
- `VOUCHER_CREATED`, `VOUCHER_REDEEMED`, `VOUCHER_VOIDED`
- Compliance: trace every voucher's lifecycle

## 🧪 Tests (24/24 passing)

```
✅ T01-T04: createVoucher validation
✅ T05: auto-generated 10-char code
✅ T06: custom code
✅ T07: validate rejects unknown code
✅ T08: validate returns discount calculation
✅ T09: validate rejects expired
✅ T10: validate rejects not-started
✅ T11: validate enforces min_purchase
✅ T12: validate enforces per_user_limit
✅ T13: redeem percentage discount
✅ T14: redeem fixed discount
✅ T15: redeem caps by max_discount
✅ T16: redeem exhausts voucher
✅ T17: redeem rejects exhausted
✅ T18: voidVoucher cancels unredeemed
✅ T19: voidVoucher rejects with redemptions
✅ T20-T22: list + stats
✅ T23-T24: events
```

## 🗄️ Database Schema

### `vouchers`
- `voucher_id TEXT UNIQUE` (VCH-{ts}-{seq})
- `code TEXT UNIQUE` (10-char or custom)
- `merchant_id`, `name`
- `discount_type` (percentage|fixed), `discount_value`
- `min_purchase`, `max_discount`
- `total_quantity`, `per_user_limit`, `redeemed_count`
- `valid_from`, `valid_until TIMESTAMPTZ` (required)
- `applicable_token_id`, `applicable_products JSONB`
- `status` (active/paused/expired/exhausted)
- **CHECK:** `valid_until > valid_from`
- **CHECK:** percentage 0-100

### `voucher_redemptions`
- `redemption_id`, `voucher_id FK`, `code`, `member_id`
- `purchase_amount`, `discount_amount`, `final_amount`
- `redeemed_at`, `actor`

### View: `v_voucher_active`
- Active + not exhausted + within date range
- `remaining = total_quantity - redeemed_count`
- `hours_until_expiry`
- `display_status` (active/not_started/expired/sold_out)

### View: `v_voucher_stats`
- Per merchant: total/active/exhausted/expired + total_discount + total_sales + total_redemptions

### Function: `get_voucher_stats(merchant_id, since)`
- Single-call: total/active vouchers + redemptions + sales + discount + unique customers

### RLS (3 roles)
- `public` → see active vouchers within date range (for marketing)
- `merchant` → see/edit own vouchers
- `member` → see own redemptions
- `admin` → all
- `service` → full CRUD

## 🐛 Bugs Closed (Indirect)

- **B8** (voucher not discount) → fixed: 2 discount types
- **B12** (campaign tracking) → fixed: per-voucher stats

## 🚀 Production Rollout (4 weeks)

### Week 1: Staging + internal pilot
1. Apply migration on staging
2. Create 5 sample vouchers (different discount types)
3. Test: create → validate → redeem → void flow
4. Verify: time windows, quantity limits, audit

### Week 2: Merchant onboarding
1. Train 5 PKG merchants on voucher creation
2. Each creates 1-2 real vouchers
3. Monitor: redemption rate, invalid attempts, support tickets
4. Refine UX based on feedback

### Week 3: UAT with 100 users
1. Distribute vouchers via LINE/Facebook groups
2. Test at POS + online
3. Track: redemption rate, time-to-redeem, abuse patterns

### Week 4: Public launch
1. Open voucher creation to all merchants
2. Marketing: "ใช้คูปองลด 20% วันนี้!"
3. Campaign templates (Black Friday, New Year, etc.)
4. Analytics dashboard for merchants

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Merchant creates fake high discount | Lost revenue | KYC for pro+ tier, max 50% without approval |
| User redeems too fast (bot) | Abuse | Rate-limit + CAPTCHA + per_user_limit |
| Voucher forgotten | Low redemption | Email reminder 50% through campaign |
| Code leaked publicly | One-time use only | per_user_limit + audit log |
| Voucher never redeemed | Lost campaign | Auto-expire, mark inactive after valid_until |
| Min purchase too high | No usage | Show prominently in display |

## 📊 Success Metrics

- **M-1: Redemption rate** = redeemed / total_quantity (target: >60% in valid period)
- **M-2: Time to redeem** = avg hours from issue to first redemption (target: <48h)
- **M-3: Sales lift** = sales during campaign vs baseline (target: +30%)
- **M-4: Discount ratio** = total_discount / total_sales (target: <25% sustainable margin)
- **M-5: New customers via voucher** = unique_members / total_redemptions (target: >40% new)

## 🔗 Related PFs

- **PF-5 (AuditEngine):** every voucher action audited
- **PF-6 (MerchantEngine):** vouchers belong to merchant's token
- **PF-3 (RewardEngine):** voucher can be granted as reward
- **PF-4 (EventBus):** publish `voucher.created`, `voucher.redeemed`, `voucher.voided`
- **PF-9 (Subscription):** Pro subscribers get exclusive vouchers
- **PF-11 (Gift Card):** complementary (gift vs discount)

## 🎬 Demo

**Console:** `https://likepoint-2.0.pages.dev/apps/admin-console/pages/voucher-console.html`

**Try:**
1. Create voucher: "Bangkok Sale 20% Off", percentage 20, qty 100, 7-day expiry
2. Switch to "Validate & Redeem" → enter code, member M-1, purchase ฿1000
3. See discount ฿200, final ฿800
4. Click Redeem → success
5. Try again with same code → sold out
6. Create 1-day voucher → check active in list

---

**Cycle 12 Complete.** 🎉 12 cycles · 348 tests · ~22,650 insertions · 100% deploy success.
