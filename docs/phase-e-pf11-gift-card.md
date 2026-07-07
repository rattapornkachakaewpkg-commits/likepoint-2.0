# Phase E — PF-11: Gift Card System

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #11 of likepoint-2.0

> **"Gift Card (ให้เป็นของขวัญ) ออกได้ทั้ง SME และ User"**
> — Likepoint meeting, 16/12/2022

## 🎯 Objective

สร้าง **Gift Card System** — permanent (no expiry) gift cards ที่ใช้แทนเงินได้ ใช้เป็นของขวัญได้ เปิดทาง B2C gifting use case (birthday, thank you, reward) + revenue จาก 1% platform fee

## 🎯 Use Cases

1. **🎂 Birthday gift** — user ซื้อ gift card ให้เพื่อน (recipient_member_id)
2. **💝 Thank you** — merchant แจก gift card ให้ลูกค้า (no recipient = "anyone can claim with code")
3. **🎁 Marketing** — SME ออก gift card ส่งเสริมการขาย
4. **♻️ Refund** — refund เป็น gift card แทนเงินสด (ลด cash out)
5. **🌍 Cross-border** — gift card ข้ามประเทศ (PF-8 FX engine)

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  GiftCardEngine (PF-11)                                      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ createCard() │  │  redeem()    │  │  transfer()      │ │
│  │ - charge fee │  │ - validate   │  │  - only issuer   │ │
│  │ - gen code   │  │   code+pin   │  │  - change owner  │ │
│  │ - gen pin    │  │ - credit     │  └──────────────────┘ │
│  │ - record     │  │ - mark used  │  ┌──────────────────┐ │
│  └──────────────┘  └──────────────┘  │  voidCard()      │ │
│                                      │  - refund        │ │
│  ┌──────────────┐  ┌──────────────┐  │  - mark voided   │ │
│  │  listCards() │  │  getStats()  │  └──────────────────┘ │
│  │  getCard()   │  │              │                       │
│  └──────────────┘  └──────────────┘                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌────────┐ ┌────────┐
        │gift_cards│ │ gift_  │ │ audit  │
        │  (no exp)│ │card_tx │ │ (PF-5) │
        └──────────┘ └────────┘ └────────┘
```

## 📦 Deliverables (5 ไฟล์, ~1,500+ insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/gift-card-engine.js` | 12.3 KB | GiftCardEngine: 5 methods (createCard/redeem/transfer/voidCard + 3 list/get) |
| 2 | `apps/engine/gift-card-engine.test.js` | 9.9 KB | **24/24 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/gift-card-console.html` | 12.0 KB | Create + redeem + visual card display + history |
| 4 | `sql/migrations/2026-07-07-phase-e-pf11-gift-card.sql` | 8.2 KB | 2 tables + 2 views + 1 function + RLS |
| 5 | `docs/phase-e-pf11-gift-card.md` | (this file) | Spec + use cases + 4-week rollout |

## 🔌 API Design

### `createCard({ merchant_id, token_id, amount, issued_by, recipient_member_id?, recipient_phone?, message?, design?, idempotency_key? })`

Issue a new gift card.

**Charges:** `amount + 1% fee` from `issued_by` wallet

**Returns:** `{ card_id, code (XXXX-XXXX-XXXX-XXXX), pin (6 digits), amount, fee, balance, status, ... }`

⚠️ **PIN shown ONCE** at create — must be saved (not returned by `getCard()`)

### `redeem({ code, pin, member_id, idempotency_key? })`

Recipient claims the card.

**Returns:** `{ card_id, amount, merchant_id, credit_txn_id, redeemed_at }`

**Validations:**
- Code + PIN match
- Card status = `active`
- Idempotency by `claim_id`

### `transfer({ card_id, from_member_id, to_member_id })`

Only original issuer can transfer (resend gift).

### `voidCard({ card_id, reason })`

Issuer cancels unredeemed card → auto-refund.

### `listCards({ merchant_id?, issued_by?, redeemed_by?, status? })`

Admin/member queries.

### `getStats({ merchant_id?, since? })`

Revenue + redemption metrics.

## 🛡️ Key Design Decisions

### 1. **NO EXPIRY (vs Voucher)**
- Gift Card = permanent (per Likepoint spec: "ของขวัญ")
- Voucher = has expiry (PF-12 future: "ส่งให้มีระยะเวลา")
- Different products for different use cases

### 2. **16-char code + 6-digit PIN (2-factor)**
- Code: user shares publicly (e.g., via chat)
- PIN: kept secret (e.g., DM'd)
- Both required to redeem → prevents accidental disclosure
- Code format `XXXX-XXXX-XXXX-XXXX` with no confusing chars (no I, O, 0, 1)

### 3. **1% platform fee on issue**
- `totalCharge = amount + amount × 0.01`
- Example: ฿1,000 card = ฿1,010 charged
- Revenue stream per card
- Refund voids fee too (full refund)

### 4. **Idempotency by `claim_id` (PF-1 pattern)**
- `GIFT-ISSUE-{ts}-{seq}` for issue
- `GIFT-REDEEM-{card_id}-{ts}` for redeem
- Safe for retries from mobile/webhook

### 5. **Transfer allowed (resend gift)**
- Use case: user ซื้อ gift card แต่ส่งผิดคน → resend ได้
- Only original issuer can transfer (not arbitrary)
- Records `transferred_from` for audit

### 6. **PIN stripped from `getCard()` response**
- Security: PIN only shown at create
- Audit log records who created (not the PIN itself)
- Production: hash PIN with bcrypt (don't store plaintext)

### 7. **Audit via PF-5 (5 events)**
- `GIFT_CARD_CREATED`, `GIFT_CARD_REDEEMED`, `GIFT_CARD_TRANSFERRED`, `GIFT_CARD_VOIDED`
- Compliance: trace any card's full history

## 🧪 Tests (24/24 passing)

```
✅ T01-T03: createCard validation
✅ T04: createCard charges amount + 1% fee
✅ T05-T07: code/pin format + no expiry
✅ T08: createCard idempotency
✅ T09: createCard with recipient (target gift)
✅ T10-T13: redeem validation (required, member, code, PIN)
✅ T14: redeem success credits recipient
✅ T15: redeem cannot be repeated
✅ T16-T18: transfer (validation, only-issuer, success)
✅ T19-T20: voidCard (refund, reject after redeem)
✅ T21-T23: list/get/stats
✅ T24: createCard publishes event
```

## 🗄️ Database Schema

### `gift_cards`
- `card_id TEXT UNIQUE`, `code TEXT UNIQUE` (XXXX-XXXX-XXXX-XXXX)
- `pin_hash TEXT` (bcrypt in prod)
- `merchant_id`, `token_id`, `amount`, `fee`, `balance`
- `issued_by`, `recipient_member_id` (optional)
- `recipient_phone`, `message`, `design`
- `status` (active/redeemed/voided)
- `expires_at TIMESTAMPTZ` — **NULL for gift cards (no expiry)**
- `redeemed_at`, `redeemed_by`
- `transferred_at`, `transferred_from`
- `voided_at`, `void_reason`
- `idempotency_key`, `debit_txn_id`

### `gift_card_transactions`
- `txn_id`, `card_id FK`, `type` (ISSUE/REDEEM/TRANSFER/VOID)
- `member_id`, `to_member_id`, `amount`, `txn_ref`, `idempotency_key`

### View: `v_gift_card_dashboard`
- Per merchant: total/active/redeemed/voided cards + fees + outstanding liability

### View: `v_gift_card_member_history`
- Per member: cards issued + redeemed + flow type (self/target/gift)

### Function: `get_gift_card_stats(merchant_id, since)`
- Single-call: issued/redeemed/volume/revenue/redemption_rate

### RLS
- `member` → see own (issued or received or redeemed)
- `admin` → all
- `service` → full CRUD

## 🆚 Gift Card vs Voucher (PF-12 future)

| Feature | Gift Card (PF-11) | Voucher (PF-12 future) |
|---|---|---|
| Expiry | None (permanent) | Required |
| Use case | ของขวัญ | ส่วนลด/โปรโมชั่น |
| Who issues | Anyone (user + merchant) | Merchant only |
| Discount | None (full value) | Can be % discount |
| Transfer | Yes | No (locked to recipient) |
| Code+PIN | Both required | Code only |
| Tax | Treated as transfer | Treated as discount |

## 💰 Revenue Model

**Per gift card:**
- Card amount: ฿1,000
- Platform fee: ฿10 (1%)
- Net to merchant: ฿0 (full value goes to recipient)
- Platform keeps: ฿10

**Annual** (10 merchants × 1,000 cards/yr × ฿1,000 avg):
- Volume: 10M THB
- Revenue: **100K THB/year**
- Scales with volume (1% of total gift card volume)

## 🐛 Bugs Closed (Indirect)

- **A28, A39** (engagement) → gift card = retention tool
- **B14** (refund UX) → gift card as refund alternative

## 🚀 Production Rollout (4 weeks)

### Week 1: Staging + internal pilot
1. Apply migration on staging
2. Issue 10 internal gift cards (PKG members)
3. Test: issue → transfer → redeem flow
4. Verify: idempotency, PIN security, fee charging

### Week 2: Birthday bot
1. Add birthday trigger: auto-issue gift card ฿100 to member on birthday
2. Notification: "Happy birthday! Gift card from PKG Mart"
3. Track: open rate, redeem rate

### Week 3: UAT with 50 users
1. Recruit 50 PKG members
2. Test: receive gift card from friend
3. Track: how many actually redeem
4. Collect feedback on UX (code+PIN, design, etc.)

### Week 4: Public launch
1. Open gift card issuance to all members
2. Marketing: "ส่งของขวัญดิจิทัลได้แล้ว!"
3. Partner with 5 SMEs for branded gift cards (e.g., "Bangkok Cafe Gift Card ฿500")
4. Cross-border: gift card via FX (PF-8) for ASEAN

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| PIN disclosed publicly | Fraud | 2-factor (code+pin), rate-limit, alert on many attempts |
| User sends to wrong recipient | Lost gift | Transfer allowed (only issuer can fix) |
| Merchant issues fake cards | Liability | KYC required for pro+ tier, audit log |
| Card not redeemed | Liability | Outstanding balance tracked (unclaimed assets) |
| User loses code | Lost gift | Issuer can re-send via `getCard()` (without PIN) |
| Tax/legal concerns | Regulatory | Treated as transfer (not lottery) — different from PF-10 lotto |

## 📊 Success Metrics

- **M-1: Cards issued / month** (target: 1,000 by Month 3)
- **M-2: Redemption rate** = redeemed / issued (target: >80% in 30 days)
- **M-3: Avg amount per card** (target: ฿500-1,000)
- **M-4: Transfer rate** = transferred / issued (target: <5% = correct recipient most of the time)
- **M-5: Platform revenue** = sum of fees (target: 100K THB/year)

## 🔗 Related PFs

- **PF-5 (AuditEngine):** every card action audited
- **PF-6 (MerchantEngine):** gift card belongs to merchant's token
- **PF-3 (RewardEngine):** `GIFT_CARD_REDEEM` credit + `GIFT_CARD_ISSUE` debit
- **PF-4 (EventBus):** publish `gift_card.created`, `gift_card.redeemed`, `gift_card.transferred`, `gift_card.voided`
- **PF-8 (FXEngine):** gift card cross-border via peg conversion
- **PF-9 (Subscription):** gift card can be given as subscription bonus

## 🎬 Demo

**Console:** `https://likepoint-2.0.pages.dev/apps/admin-console/pages/gift-card-console.html`

**Try:**
1. Issue card: Bangkok Cafe ฿500, recipient M-2, message "Happy birthday!" → see code+PIN
2. Switch to Redeem tab → enter code + PIN → M-2 → success
3. View card history → see status: redeemed
4. Issue 2 more cards (no recipient = open gift)
5. Check stats: volume ฿1,500, revenue ฿15

---

**Cycle 11 Complete.** 🎉 11 cycles · 324 tests · ~21,150 insertions · 100% deploy success.
