# Phase E — PF-6: White-Label Merchant Engine

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #6 of likepoint-2.0

> **"Likepoint 2.0 is a White-Label Loyalty Token SaaS — every Business Unit creates, brands, and runs their own loyalty token."**
> — PVP, 28/09/2022

## 🎯 Objective

เปลี่ยน `likepoint-2.0` จาก **single-tenant loyalty platform** → **multi-tenant White-Label SaaS** ที่ให้ BU (Business Unit) / SME เช่าใช้และออกแบบ token แบรนด์ตัวเองได้ โดยไม่กระทบ platform core

## 🩹 Root Cause ที่ต้องแก้ (จาก Vision Doc)

**PVP เคยล้มเหลว** กับ model **"1 Likepoint ใช้ทุกบริษัท"** (Likepoint 1.0) เพราะ:
1. ❌ Likepoint 1 ผูก 3 ประเทศ × 3 สกุลเงิน → **FX risk** ตกไปที่ BU
2. ❌ BU แต่ละที่มี **incentivize ต่างกันมาก** (User-driven vs Product-driven)
3. ❌ ทีม Likepoint บริหาร token ให้ BU ไม่สอดรับ → **white-label คือทางรอด**

**PF-6 = Likepoint 2.0 = ทำรอบ 2 ให้สำเร็จ** — แยก scope ให้ชัด

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MerchantEngine (PF-6)                                       │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  onboard()   │  │  createToken │  │  setPOIRules()   │ │
│  │  - register  │  │  - name      │  │  - event         │ │
│  │  - KYC       │  │  - symbol    │  │  - reward        │ │
│  │  - tier      │  │  - decimals  │  │  - cooldown      │ │
│  │  - config    │  │  - peg       │  │  - audience      │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  mintTokens  │  │  getStats    │  │  audit()         │ │
│  │  - amount    │  │  - holders   │  │  - via PF-5      │ │
│  │  - cost      │  │  - supply    │  └──────────────────┘ │
│  │  - invoice   │  │  - volume    │                       │
│  └──────────────┘  └──────────────┘                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌────────┐ ┌────────┐
        │ merchants│ │ tokens │ │ poi_   │
        │ + tiers  │ │ (white │ │ rules  │
        │ + config │ │  label)│ │        │
        └──────────┘ └────────┘ └────────┘
                          │
                          ▼
                  ┌──────────────┐
                  │  AuditEngine │
                  │  (PF-5)      │
                  └──────────────┘
```

## 📦 Deliverables (5 ไฟล์, ~1,800+ insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/merchant-engine.js` | 15.2 KB | MerchantEngine: 9 methods (onboard/createToken/mintTokens/setPOIRules/getStats + 3 list APIs) |
| 2 | `apps/engine/merchant-engine.test.js` | 13.9 KB | **28/28 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/merchant-onboarding.html` | 19.7 KB | 4-step wizard: register → token → POI → done |
| 4 | `sql/migrations/2026-07-07-phase-e-pf6-merchant.sql` | 11.0 KB | 4 tables + 2 views + 1 function + RLS (3 roles) |
| 5 | `docs/phase-e-pf6-merchant.md` | (this file) | Spec + business model + 4-week rollout |

## 🔌 API Design

### `onboardMerchant({ business_name, contact_email, country, tier, kyc_docs? })`

Onboard a new merchant (BU/SME) to the platform.

**Tiers:**
| Tier | Tokens | Supply Cap | KYC | Monthly Fee |
|---|---|---|---|---|
| `starter` | 1 | 10,000 | Not required | Free |
| `pro` | 5 | 1,000,000 | Required | 5,000 THB |
| `enterprise` | Unlimited | Unlimited | Full + audit | Custom |

**Returns:** `{ merchant_id, business_name, tier, kyc_status, api_key, created_at }`

**Note:** `api_key` shown ONCE — merchant must save. Hashed in production.

### `createToken({ merchant_id, name, symbol, decimals?, peg_currency?, peg_rate?, icon_url?, metadata? })`

Create a white-label token for the merchant.

**Returns:** `{ token_id, merchant_id, name, symbol, decimals, peg_currency, peg_rate, total_supply: 0, status }`

**Validations:**
- Symbol unique per merchant
- Decimals 0-18
- peg_currency ISO-4217 (3 uppercase)
- peg_rate > 0
- Tier limit enforced

### `mintTokens({ merchant_id, token_id, amount, payment_ref? })`

Mint new tokens (BU buys tokens to distribute to customers).

**Returns:** `{ mint_batch_id, amount, new_total_supply, new_circulating_supply, minted_at }`

**Validations:**
- Amount > 0
- Token belongs to merchant
- Supply cap (per tier) not exceeded
- KYC required for mint > 100,000 tokens

### `setPOIRules({ merchant_id, token_id, rules[] })`

Set point-of-interest reward rules.

**Rule format:**
```js
{
  event_type: 'daily_login' | 'purchase' | 'referral' | 'review' | 'birthday' | 'custom',
  reward_amount: 100,
  reward_type: 'fixed' | 'multiplier' | 'random',
  cooldown: 'PT24H',  // ISO-8601
  audience_filter: { tier: 'gold', country: 'TH', opt_in: true },
}
```

**Returns:** `{ rules, count }`

### `getStats({ merchant_id, since? })`

Aggregated merchant statistics.

**Returns:** `{ merchant_id, business_name, tier, kyc_status, token_count, total_supply, circulating_supply, poi_rule_count, poi_triggers_since }`

### List APIs

- `listMerchants({ status?, tier?, country?, limit? })`
- `listTokens({ merchant_id?, status?, limit? })`
- `listPOIRules({ merchant_id?, token_id?, status?, limit? })`

## 🛡️ Key Design Decisions

### 1. **Hard isolation between merchants**
- `merchant_id` is the **tenant boundary** in every query
- No cross-merchant token transfer (v1) — Phase E.2 จะทำ
- Audit log per-merchant: admin can see all, merchant sees own

### 2. **Token-as-Service (TaaS), not token-as-investment**
- Tokens have **utility purpose** (redeem rewards), not investment promise
- No "earn interest" / "trade on exchange" features
- Compliant with most local regulations

### 3. **Peg-locked, not floating**
- 1 token = 1 สตางค์ (default), merchant can set custom
- No FX risk transfer to BU (lesson from Likepoint 1.0)
- Each country = 1 base rate (Kowit's rule)

### 4. **KYC tiered by risk**
- `starter`: email only → 1 token, 10K supply cap
- `pro`: business docs → 5 tokens, 1M supply cap
- `enterprise`: full KYC + financial review → unlimited

### 5. **POI rules = flexible, not hardcoded**
- 6 trigger types: `daily_login`, `purchase`, `referral`, `review`, `birthday`, `custom`
- Cooldown + audience filter at rule level
- Same engine can serve "User-driven" BU (high reward) or "Product-driven" BU (low reward, frequent)

### 6. **Audit everything via PF-5**
- Every `onboard` / `createToken` / `mint` / `setPOI` = 1 audit entry
- `merchant_id` in audit → easy to filter "what did merchant X do last week"
- Compliance team can search all merchant actions

## 🧪 Tests (28/28 passing)

```
✅ T01-T04: validation (email, country, tier, required fields)
✅ T05: starter tier (no KYC)
✅ T06-T07: pro tier (KYC required + approved)
✅ T08: duplicate business per country
✅ T09: same name different country
✅ T10-T11: events + audit
✅ T12: createToken
✅ T13: duplicate symbol per merchant
✅ T14: same symbol different merchants
✅ T15: starter 1-token limit
✅ T16: pro 5-token limit
✅ T17-T18: decimals + peg_currency validation
✅ T19: mint increases supply
✅ T20: mint respects cap
✅ T21: large mint requires KYC
✅ T22: cross-merchant mint blocked
✅ T23-T24: POI validation + multi-rule
✅ T25: getStats aggregation
✅ T26-T27: list filters
✅ T28: KYC rejected
```

**Coverage:** 100% of public methods + edge cases.

## 🗄️ Database Schema

### `merchants`
- `merchant_id TEXT UNIQUE` (MCH-{ts}-{seq})
- `business_name`, `slug UNIQUE per country`
- `country` (ISO-3166), `tier`, `kyc_status`
- `kyc_documents JSONB`, `api_key_hash`
- `config JSONB` (branding, notifications)
- `status` (active, suspended, churned)
- **Unique:** `(country, slug)`

### `merchant_tokens`
- `token_id TEXT UNIQUE` (TOK-{ts}-{seq})
- `merchant_id FK` → `merchants(merchant_id)` ON DELETE CASCADE
- `name`, `symbol`, `decimals` (0-18)
- `peg_currency` (ISO-4217), `peg_rate`
- `total_supply`, `circulating_supply` (NUMERIC 24,2)
- `metadata JSONB`
- **Unique:** `(merchant_id, symbol)`

### `poi_rules`
- `rule_id`, `merchant_id`, `token_id` FK
- `event_type` (6 types), `reward_amount`, `reward_type`
- `cooldown INTERVAL`
- `audience_filter JSONB`
- `triggered_count`, `last_triggered_at`

### `token_mints`
- `mint_batch_id`, `merchant_id`, `token_id`
- `amount`, `payment_ref`, `actor`
- Audit trail of all mints

### View: `v_merchant_summary`
- Aggregated stats for admin dashboard

### View: `v_poi_recent`
- Recent POI activity

### Function: `get_merchant_stats(merchant_id)`
- Single-call aggregated stats

### RLS (3 roles)
- `merchant` role → see/edit own data only (`merchant_id` = session merchant)
- `admin` role → see all, edit tier/kyc
- `service` role → full CRUD (for engines)
- Default deny

## 🚀 Production Rollout (4 weeks)

### Week 1: Staging + Internal PKG
1. Apply migration on staging
2. Onboard 3 internal PKG businesses (Kowit, POM, Aod) as pilot
3. Each creates 1 token, sets 1 POI rule (daily_login)
4. E2E test: register → onboard → create token → mint → customer claim POI

### Week 2: UAT with 5 SME pilot
1. 5 SME from network (ร้านอาหาร, คาเฟ่, บริการ)
2. Train 1 hour → onboard → create token
3. Collect feedback 1 week

### Week 3: Public soft-launch
1. Open registration with `starter` tier (free)
2. Limit: 100 merchants / month
3. Monitor: onboarding completion rate, first-token creation time

### Week 4: GA + Pro tier
1. Open `pro` tier (5,000 THB/mo) with payment
2. Stripe/promptpay integration for billing
3. Marketing: announce in LINE/Facebook groups

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| BU mints supply เยอะเกินไป | Currency devaluation | Cap `circulating_supply` per tier + per-token |
| KYC bypass | AML/CFT risk | KYC required for mint > 100K tokens |
| Smart contract bug (future) | Token loss | v1 ใช้ DB-based (not blockchain) — easier rollback |
| Multiple merchants use same symbol | Brand confusion | UNIQUE per `(merchant_id, symbol)` + admin review for pro+ |
| White-label domain abuse | Phishing risk | Domain verification required for `pro+` tier |
| Cross-merchant transfer (legal gray) | Regulatory risk | Disable in v1, re-evaluate in v2 |

## 📊 Success Metrics (post-launch)

- **M-1: Onboarding completion** = completed / started × 100% (target: >70%)
- **M-2: First-token creation time** = p95 from onboard to token live (target: <1 hour)
- **M-3: Active merchants** = merchants with ≥1 mint in last 30 days (target: 50 by Month 3)
- **M-4: POI trigger rate** = triggers / active members × 100% (target: >40% daily)
- **M-5: Revenue** = tier fees + mint fees (target: 100K THB by Month 6)

## 🔗 Related PFs

- **PF-5 (AuditEngine):** every merchant action audited via `audit.log()`
- **PF-3 (RewardEngine):** merchant's POI rules → `reward.granted` event
- **PF-4 (EventBus):** publish `merchant.onboarded`, `token.minted`, `poi.rules_updated`
- **PF-1 (AAM Migration):** existing AAM merchants can migrate to native white-label
- **PF-7 (POI Marketing — next):** extends PF-6 with deeper marketing tools
- **PF-8 (Multi-Currency — next):** enables cross-border white-label

## 🎬 Demo

**Admin Console:** `https://rattapornkachakaewpkg-commits.github.io/likepoint-2.0/apps/admin-console/pages/merchant-onboarding.html`

**Try:**
1. Step 1: Register "Bangkok Cafe" (Pro tier + KYC) → 30 วินาที
2. Step 2: Create token "Bangkok Cafe Point" (BCP) → peg 1:1 สตางค์ THB
3. Step 3: Set POI rule → `daily_login` → reward 100 BCP → cooldown 24h
4. Step 4: Done → API key shown once, audit log created

---

**Cycle 6 Complete.** 🎉 6 cycles · 194 tests · ~14,000 insertions · 100% deploy success.
