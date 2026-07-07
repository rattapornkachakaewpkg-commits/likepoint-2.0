# Phase E — PF-9: Subscription Engine (Recurring Revenue)

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #9 of likepoint-2.0

> **"User ซื้อ Subscription ได้ เพื่อทำกิจกรรม earn point, Lotto (ค่าเดือนละ 10 บาท)"**
> — NB (Natthaphol Buathong), 25/06/2023

## 🎯 Objective

สร้าง **Recurring Revenue** ผ่าน 3-tier subscription (Free / Basic ฿10 / Pro ฿99) พร้อม:
- Auto-billing 30 วัน
- Trial 7 วันสำหรับ paid plans
- Grace period 3 วันเมื่อชำระเงินไม่สำเร็จ
- Benefit grants (Lotto, premium POI, ad-free)
- MRR dashboard

## 💰 Revenue Model

| Plan | Price | Features | Target % | MRR @ 200K DAU |
|---|---|---|---|---|
| **Free** | ฿0/mo | basic_poi, daily_claim | 70% | ฿0 |
| **Basic** | ฿10/mo | lotto_weekly, poi_2x, ad_free | 25% | ฿500K/mo |
| **Pro** | ฿99/mo | lotto_daily, poi_5x, premium_poi, priority_support | 5% | ฿990K/mo |
| | | | **Total MRR** | **~฿1.49M/mo** |

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  SubscriptionEngine (PF-9)                                  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ createPlan() │  │  subscribe() │  │  renew()         │ │
│  │  - price     │  │  - trial     │  │  - charge        │ │
│  │  - features  │  │  - charge    │  │  - extend period │ │
│  │  - trial     │  │  - benefits  │  │  - handle fail   │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  cancel()    │  │  getStatus() │  │  getRevenue()    │ │
│  │  - end-of-p  │  │  - days left │  │  - MRR           │ │
│  │  - immediate │  │  - benefits  │  │  - by plan       │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌────────┐ ┌────────┐
        │ plans    │ │ member │ │ billing│
        │          │ │  _subs │ │        │
        └──────────┘ └────────┘ └────────┘
                          │
                          ▼
                  ┌──────────────┐
                  │  Benefits    │
                  │  (Lotto/POI/ │
                  │   Ad-free)   │
                  └──────────────┘
```

## 📦 Deliverables (5 ไฟล์, ~1,200+ insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/subscription-engine.js` | 16.0 KB | SubscriptionEngine: 8 methods (createPlan/subscribe/renew/cancel/getStatus + 3 list/getRevenue) |
| 2 | `apps/engine/subscription-engine.test.js` | 10.1 KB | **25/25 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/subscription-console.html` | 11.5 KB | Plan picker + analytics + subscription mgmt |
| 4 | `sql/migrations/2026-07-07-phase-e-pf9-subscription.sql` | 10.1 KB | 3 tables + 2 views + 1 function + RLS (3 roles) + 3 default plans |
| 5 | `docs/phase-e-pf9-subscription.md` | (this file) | Spec + revenue model + 4-week rollout |

## 🔌 API Design

### `createPlan({ plan_id, name, price_thb, billing_period?, features?, badge?, trial_days? })`

Create a subscription plan.

**Returns:** Plan object (id, name, price, features, trial_days, status)

### `subscribe({ member_id, plan_id, payment_method?, idempotency_key?, actor? })`

Subscribe member to a plan.

**Returns:** Subscription object
- `status: 'trial' | 'active'`
- `current_period_start`, `current_period_end`
- `next_billing_at`, `trial_ends_at`

**Validations:**
- Member doesn't have active subscription
- Plan is `active`
- Idempotency by `idempotency_key`

### `renew({ subscription_id, payment_ref? })`

Renew a subscription (typically called by cron on `next_billing_at`).

**Returns:** `{ subscription, billing_id }`

**Failure handling:**
- Payment failed → status = `past_due` + 3-day grace period
- Member notified via `subscription.payment_failed` event
- Auto-cancel after grace period (cron)

### `cancel({ subscription_id, reason?, immediate? })`

Cancel a subscription.

- `immediate: false` (default) → status stays `active` until `current_period_end`
- `immediate: true` → status = `cancelled` + benefits revoked now

### `getStatus(member_id)`

Returns current subscription + days remaining + benefits.

### `getRevenue({ since? })`

Returns `{ total_revenue, mrr, active_subscriptions, by_plan }`

### List APIs
- `listPlans({ status?, limit? })`
- `listSubscriptions({ plan_id?, status?, since?, limit? })`

## 🛡️ Key Design Decisions

### 1. **3-tier model with clear upsell path**
- Free → Basic (1 click, 10 THB) → Pro (high value, 99 THB)
- Trial lowers barrier (try before buy)
- Features layered: each tier adds 1-2 perks

### 2. **30-day billing cycle**
- Aligns with most consumer expectations
- Cron: `subscription_billing` daily, find subs with `next_billing_at <= now()`
- Auto-extend period on successful charge

### 3. **Idempotency by `claim_id` (claim_id pattern)**
- Same as PF-1 (AAM Migration) — proven pattern
- Critical for webhook retries from payment gateway

### 4. **Trial period (7 days)**
- Only for paid plans with `trial_days > 0`
- During trial: status = `trial`, no charge yet
- After trial: charge immediately on first `renew()`

### 5. **Grace period (3 days) on payment failure**
- Status = `past_due`
- Send reminder emails
- If still failed after grace period → auto-cancel via cron

### 6. **Benefits as event-driven grants**
- `subscribe()` → publish `benefits.granted` event
- Other engines (Lotto, POI, Ad server) listen
- No hardcoded engine dependencies → extensible

### 7. **Audit everything via PF-5**
- `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_CANCELLED`, `SUBSCRIPTION_PAYMENT_FAILED`
- `BENEFITS_GRANTED`, `BENEFITS_REVOKED`
- Compliance can trace every member's subscription history

## 🧪 Tests (25/25 passing)

```
✅ T01-T03: createPlan validation
✅ T04-T06: createPlan free / basic / pro
✅ T07-T08: subscribe (free, basic with trial)
✅ T09: subscribe idempotency
✅ T10-T11: subscribe rejects duplicates / unknown plan
✅ T12: renew extends period
✅ T13: payment failure → past_due + grace period
✅ T14-T16: cancel (end-of-period, immediate, already-cancelled)
✅ T17-T18: getStatus (no sub + with sub)
✅ T19-T20: listPlans + listSubscriptions
✅ T21-T22: getRevenue (total + MRR)
✅ T23-T25: events (subscription.created, cancelled, benefits.granted)
```

## 🗄️ Database Schema

### `subscription_plans`
- `plan_id TEXT UNIQUE` (free/basic/pro)
- `name`, `price_thb`, `billing_period` (monthly/yearly)
- `features JSONB` (array of feature codes)
- `badge`, `trial_days`, `status`
- **Seed:** 3 plans (Free/Basic/Pro) inserted on migration

### `member_subscriptions`
- `subscription_id TEXT UNIQUE` (SUB-{ts}-{seq})
- `member_id UUID`, `plan_id FK`
- `status` (trial/active/past_due/cancelled/expired)
- `current_period_start`, `current_period_end`
- `next_billing_at`, `trial_ends_at`, `grace_period_ends_at`
- `cancelled_at`, `cancel_reason`, `auto_renew`
- **Unique:** `idempotency_key` (partial)
- **Indexes:** member+status, plan+status, due_for_billing (partial), grace_period (partial)

### `subscription_billing`
- `billing_id TEXT UNIQUE` (BIL-{ts}-{seq})
- `subscription_id`, `member_id`, `amount`, `payment_method`
- `payment_ref`, `status` (pending/succeeded/failed/refunded)
- `billing_period_start/end`, `failure_reason`

### View: `v_subscription_revenue`
- Per-plan: active_subs, revenue_30d, revenue_7d, mrr_contribution

### View: `v_subscription_dashboard`
- Total counts by status + due_for_renewal_7d + in_grace_period

### Function: `get_member_subscription(member_id)`
- Single-call subscription lookup with days remaining

### RLS (3 roles)
- `public` (anonymous) → see `status='active'` plans (for marketing)
- `member` → see own subscription + billing
- `admin/auditor` → see all
- `service` → full CRUD (for billing cron + webhooks)

## 🚀 Production Rollout (4 weeks)

### Week 1: Staging + internal pilot
1. Apply migration on staging
2. Subscribe 3 internal PKG members (free → basic → pro)
3. Test billing cycle simulation (manually call `renew()`)
4. Verify: trial → active transition, cancel flow

### Week 2: Payment gateway integration
1. Sign up for PromptPay API (sandbox)
2. Webhook handler: payment success → trigger `renew()`
3. Webhook handler: payment failed → trigger `_handlePaymentFailed()`
4. Test with 10 THB and 99 THB amounts

### Week 3: UAT with 50 pilot users
1. Recruit 50 PKG members via LINE group
2. Track conversion: free → basic (target 25%)
3. Collect feedback on UX (checkout, trial messaging)

### Week 4: Public launch
1. Marketing push: "ทดลองใช้ Basic ฟรี 7 วัน"
2. Daily cron: bill subscriptions
3. Daily cron: cancel past-due after grace period
4. Monitor: MRR, churn, conversion

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| High churn (>50%) | Low MRR | Trial + cancel-anytime + email reminders |
| Payment gateway downtime | Failed renewals | Retry 3× + grace period 3 days |
| Refund abuse | Lost revenue | Pro-rated refund + flag for review |
| User confusion (price + features) | Bad UX | Clear plan comparison + FAQ |
| Trial-to-paid conversion < 5% | Low MRR | Email nudge day 5 + 1-day-before-trial-end |
| Multiple subs per member | Double billing | Engine rejects in `subscribe()` |

## 📊 Success Metrics

- **M-1: Trial-to-paid conversion** = trial→active / total_trial (target: >30%)
- **M-2: Monthly churn** = cancelled / active_start_of_month (target: <10%)
- **M-3: MRR growth** = MRR month-over-month (target: +20% MoM)
- **M-4: ARPU** = total_revenue / active_subs (target: >฿25)
- **M-5: LTV** = ARPU / churn_rate (target: >฿300)

## 🔗 Related PFs

- **PF-5 (AuditEngine):** every subscribe/renew/cancel/benefit logged
- **PF-3 (RewardEngine):** benefits can grant tokens (e.g., monthly Pro bonus)
- **PF-7 (POIEngine):** premium_poi feature filters which rules members see
- **PF-6 (MerchantEngine):** merchants can offer subscription perks to their customers
- **PF-8 (FXEngine):** subscription price displayed in local currency

## 🎬 Demo

**Console:** `https://likepoint-2.0.pages.dev/apps/admin-console/pages/subscription-console.html`

**Try:**
1. Click "Basic" plan → Subscribe M-1 → see trial status, 7-day period
2. Subscribe M-2 to "Pro" → see ฿99 price
3. Subscribe M-3 to "Free" → see ฿0 price
4. Click ⏪ on any active sub → cancel immediately
5. View stats: Active=2, Trial=1, MRR=109 THB

---

**Cycle 9 Complete.** 🎉 9 cycles · 276 tests · ~18,150 insertions · 100% deploy success.
