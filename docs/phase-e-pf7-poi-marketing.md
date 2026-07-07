# Phase E — PF-7: POI Marketing System

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #7 of likepoint-2.0

> **"จุดยืนของ Likepoint คือ 'สร้างนิสัย' ให้ผู้ใช้กดรับเงินฟรีทุกเช้า (UBI) เพื่อให้อยู่ใน Marketing community ต่อไป"**
> — PVP, 12/01/2023

## 🎯 Objective

สร้าง **engagement loop** ที่ทำให้ user กลับมาใช้ Likepoint ทุกวัน (UBI habit) — ผ่านระบบ **POI (Point-of-Interest)** ที่ BU แต่ละรายออกแบบ rule การให้ reward ได้เอง (fixed / multiplier / random) พร้อม cooldown, audience filter, time window

## 🎯 ใช้กับอะไร (PVP Quote)

> "การทำ POI เพื่อเพิ่มรางวัล / รักษาระดับอภิสิทธิ์ / รักษาระดับค่าตอบแทน"
> — PVP, 13/10/2022

3 use cases หลัก:
1. **POI เพิ่มรางวัล** → daily login, purchase bonus
2. **POI รักษาระดับอภิสิทธิ์** → gold tier bonus, VIP perks
3. **POI รักษาระดับค่าตอบแทน** → multiplier for active users

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  POIEngine (PF-7)                                           │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  createRule  │  │  trigger()   │  │  pauseRule()     │ │
│  │  - event     │  │  - find rule │  │  resumeRule()    │ │
│  │  - reward    │  │  - audience  │  │                  │ │
│  │  - cooldown  │  │  - cooldown  │  └──────────────────┘ │
│  │  - audience  │  │  - max/user  │  ┌──────────────────┐ │
│  └──────────────┘  │  - time      │  │  listRules()     │ │
│                    │  - calculate │  │  listTriggers()  │ │
│  ┌──────────────┐  │  - credit    │  │  getRuleStats()  │ │
│  │  _calc()     │  │  - notify    │  └──────────────────┘ │
│  │  - fixed     │  │  - audit     │                       │
│  │  - multiplier│  └──────────────┘                       │
│  │  - random    │                                           │
│  └──────────────┘                                           │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌────────┐ ┌────────┐
        │ poi_     │ │ poi_   │ │ audit  │
        │ rules_v2 │ │triggers│ │ (PF-5) │
        └──────────┘ └────────┘ └────────┘
```

## 📦 Deliverables (5 ไฟล์, ~1,500+ insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/poi-engine.js` | 15.1 KB | POIEngine: 6 methods (createRule/trigger/listRules/listTriggers/getRuleStats/pause+resume) |
| 2 | `apps/engine/poi-engine.test.js` | 13.8 KB | **28/28 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/poi-builder.html` | 18.1 KB | Visual rule builder + simulator + analytics |
| 4 | `sql/migrations/2026-07-07-phase-e-pf7-poi-marketing.sql` | 9.1 KB | 2 tables + 3 views + 1 function + RLS |
| 5 | `docs/phase-e-pf7-poi-marketing.md` | (this file) | Spec + UBI habit design + 3 use cases |

## 🔌 API Design

### `createRule({ merchant_id, token_id, name, event_type, reward_amount, reward_type?, cooldown?, audience_filter?, max_triggers_per_user?, start_at?, end_at? })`

Create a POI reward rule.

**Event types:** `daily_login`, `purchase`, `referral`, `review`, `birthday`, `custom`

**Reward types:**
- `fixed` → reward = `reward_amount` constant
- `multiplier` → reward = `event_data.amount × reward_amount`
- `random` → reward = random 0 to `reward_amount`

**Cooldown format:** ISO-8601 duration (`PT24H`, `P7D`, `P1W`, `M30`)

**Audience filter:** `{ tier, country, opt_in, min_age, max_age }`

### `trigger({ merchant_id, token_id, member_id, event_type, event_data?, idempotency_key? })`

Main entry point — user does event, engine evaluates rules, credits token, sends notification.

**Returns:**
```js
{
  status: 'PROCESSED',
  triggered_at,
  results: [
    { rule_id, status: 'REWARDED' | 'COOLDOWN' | 'NOT_IN_AUDIENCE' | 'MAX_TRIGGERS_REACHED' | 'EXPIRED' | 'NOT_STARTED' | 'CREDIT_FAILED', reward_amount, ... }
  ]
}
```

**Processing order** (per matching rule):
1. Time window (start_at, end_at)
2. Audience filter
3. Cooldown (per member)
4. Max triggers per user
5. Calculate reward
6. Credit token (idempotent via `claim_id`)
7. Send notification
8. Audit log
9. Publish `poi.triggered` event

### `listRules({ merchant_id?, token_id?, event_type?, status?, limit? })`

For merchant admin dashboard.

### `listTriggers({ merchant_id?, member_id?, rule_id?, event_type?, status?, since?, limit? })`

For analytics — sortable, filterable.

### `getRuleStats({ rule_id, since? })`

Per-rule aggregated metrics.

**Returns:** `{ trigger_count, unique_members, total_rewarded, avg_per_user }`

### `pauseRule({ rule_id })` / `resumeRule({ rule_id })`

Toggle rule status.

## 🛡️ Key Design Decisions

### 1. **Idempotency by `claim_id`**
- `claim_id = POI-{rule_id}-{member_id}-{timestamp}`
- Same key → return existing trigger (no double credit)
- Critical for retry safety (network, double-click)

### 2. **Cooldown enforced at engine level (not DB)**
- In-memory lookup of last trigger per (rule, member)
- Fast comparison: `now - last_triggered_at < cooldown_ms`
- Returns `COOLDOWN` status (not throw) — caller can decide UX

### 3. **Audience filter evaluated against member profile**
- `{ tier, country, opt_in, min_age, max_age }`
- Empty filter = everyone matches
- AND semantics (all conditions must pass)

### 4. **Reward calculation supports 3 types**
- `fixed` — daily login bonus
- `multiplier` — 2x/3x spending (uses `event_data.amount`)
- `random` — lucky draw / gamification

### 5. **Time window (start_at, end_at)**
- For campaign-based rules (Black Friday, birthday month)
- Returns `NOT_STARTED` / `EXPIRED` status (not fail silently)

### 6. **Audit everything via PF-5**
- `POI_RULE_CREATED`, `POI_TRIGGERED`, `POI_RULE_PAUSED`, `POI_RULE_RESUMED`
- Every trigger has `trigger_id` for cross-service trace via `correlation_id`

### 7. **Notification non-blocking**
- `notifier.send()` failure doesn't fail the trigger
- User got the reward, just didn't get the push — we can retry later

## 🧪 Tests (28/28 passing)

```
✅ T01-T04: validation (required fields, reward_type, amount, cooldown)
✅ T05-T06: createRule happy paths
✅ T07-T08: trigger + event publishing
✅ T09: cooldown enforcement
✅ T10: idempotency
✅ T11-T12: audience filter (tier, country)
✅ T13: max_triggers_per_user
✅ T14: NO_MATCHING_RULE
✅ T15: multiplier from event_data.amount
✅ T16: random reward range
✅ T17-T18: time window (not started, expired)
✅ T19-T20: pause/resume
✅ T21-T22: list filters
✅ T23: rule stats aggregation
✅ T24: notification sent
✅ T25-T27: required fields, ISO-8601, member not found
✅ T28: credit failure handling
```

## 🗄️ Database Schema

### `poi_rules_v2`
- `rule_id TEXT UNIQUE` (POIR-{ts}-{seq})
- `merchant_id`, `token_id`, `name`, `event_type`
- `reward_amount`, `reward_type` (fixed/multiplier/random)
- `cooldown INTERVAL`, `cooldown_ms BIGINT` (for fast comparison)
- `audience_filter JSONB`
- `max_triggers_per_user INT`
- `start_at`, `end_at TIMESTAMPTZ` (campaign window)
- `triggered_count`, `total_rewarded`, `unique_users` (cumulative stats)
- **Indexes:** merchant+status, token+event, event+status (active), start+end (active)

### `poi_triggers`
- `trigger_id TEXT UNIQUE` (POIT-{ts}-{seq})
- `rule_id`, `merchant_id`, `token_id`, `member_id`
- `event_type`, `event_data JSONB`
- `reward_amount`, `credit_txn_id`, `idempotency_key`
- `status` (REWARDED, COOLDOWN, NOT_IN_AUDIENCE, MAX_TRIGGERS_REACHED, CREDIT_FAILED, EXPIRED, NOT_STARTED)
- `error TEXT` (for credit failures)
- **Indexes:** member+time, rule+time, merchant+time, status+time, idempotency_key (partial)

### View: `v_poi_rule_stats`
- Per-rule aggregated stats including 7-day window

### View: `v_poi_recent_activity`
- Last 1000 triggers with rule names

### View: `v_poi_member_streaks`
- Per-member engagement: total rewards, active days, last reward, days since

### Function: `get_poi_engagement(merchant_id, days)`
- Single-call aggregated metrics: active rules, triggers, unique users, total rewarded, top event, daily average

### RLS (3 roles)
- `merchant` → own rules + own triggers (read)
- `admin` → all rules + all triggers
- `service` → full CRUD

## 🚀 Production Rollout

### Week 1: Internal pilot (3 PKG businesses)
1. Onboard 3 internal BUs via PF-6 wizard
2. Each creates 1-2 POI rules (daily_login + purchase bonus)
3. Internal members test triggers end-to-end
4. Verify: idempotency, cooldown, audience filter, notification

### Week 2: UAT with 5 SME pilot
1. 5 SMEs create their POI rules
2. Real users (their customers) start using
3. Monitor: trigger rate, reward distribution, error rate
4. Collect feedback on UX (notification timing, reward amount)

### Week 3: Public soft-launch
1. Open POI rule builder to all merchants
2. Add 4 preset templates to dashboard
3. Monitor: rule creation rate, most popular event types

### Week 4: GA + Analytics
1. Public analytics dashboard for merchants
2. Cross-merchant benchmark (avg daily triggers per rule type)
3. A/B test reward amounts

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| BU sets huge reward, drains token supply | Inflation | Cap via `max_triggers_per_user` + per-rule supply check |
| Notification spam | User complaints | Cooldown + opt-in filter |
| Cooldown bypass (different members) | Multi-account abuse | Device fingerprinting (PF-5 audit) + member_id hashing |
| Race condition (double-trigger) | Double reward | Idempotency by `claim_id` (PF-1 pattern) |
| Audience filter too restrictive | Low engagement | Show "matched N members" preview before save |
| Time zone confusion (start_at) | Wrong trigger window | Store UTC, render in merchant's TZ |

## 📊 Success Metrics

- **M-1: DAU via POI** = unique members with ≥1 trigger / day (target: >40%)
- **M-2: Streak length** = p75 active days per member (target: ≥7 days)
- **M-3: Rule coverage** = active merchants with ≥1 POI rule (target: >80%)
- **M-4: Trigger success rate** = REWARDED / total (target: >90%)
- **M-5: Total rewards distributed** (target: 1M tokens in Month 3)

## 🔗 Related PFs

- **PF-5 (AuditEngine):** every trigger audited
- **PF-6 (MerchantEngine):** POI rules belong to merchant's token
- **PF-3 (RewardEngine):** token credit via `reward.granted` event
- **PF-4 (EventBus):** publish `poi.triggered` → wallet display refresh
- **PF-8 (Multi-Currency — next):** POI reward amount auto-converts per country

## 🎬 Demo

**Console:** `https://likepoint-2.0.pages.dev/apps/admin-console/pages/poi-builder.html`

**Try:**
1. Click preset "📅 Daily Login (UBI)" → auto-fill form → Create
2. Set member "M-1" → trigger daily_login → see +100 BCP
3. Trigger again immediately → see COOLDOWN status
4. Click preset "🌟 Gold Tier" → add audience filter `tier=gold`
5. Simulate with M-2 (silver) → see NOT_IN_AUDIENCE
6. View analytics cards at top (rules, triggers, users, rewarded)

---

**Cycle 7 Complete.** 🎉 7 cycles · 222 tests · ~15,750 insertions · 100% deploy success.
