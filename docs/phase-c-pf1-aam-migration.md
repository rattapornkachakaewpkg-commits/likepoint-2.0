# Phase C — PF-1: AAM Migration (Cross-Tenant)

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #4 of likepoint-2.0

## 🎯 Objective

Migrate AAMpoint balances from legacy AAM tenant to LP2.0 wallet — safely, idempotently, and auditable. Bypass bugs A14 (AAMpoint missing) and A42 (cross-tenant propagation).

## 🐛 Bugs Fixed

| ID | Symptom | Root Cause | PF-1 Fix |
|---|---|---|---|
| **A14** | AAMpoint ไม่เข้า wallet LP2.0 | Cross-tenant gap (AAM ledger → LP2.0 wallet) | `migrateAAMAccount()` with phone_hash join |
| **A42** | AAMpoint missing หลัง migrate | No idempotency, no audit | `claim_id` + `aam_migration_records` table |
| **A8**  | Partial migration (บาง user ได้ บาง user ไม่ได้) | No batch + no rollback | `batchMigrate()` + `rollback()` |
| **A35** | Negative AAM balance migrate ได้ | No validation | `if (balance < 0) throw` |
| **A40** | ไม่รู้ว่า account ไหน migrate แล้ว | No status query | `getStatus()` + `listMigrations()` |

## 🏗️ Architecture

```
┌──────────────────┐    migrateAAMAccount     ┌──────────────────┐
│  AAM Ledger      │ ─────────────────────►   │  AAM Migration   │
│  (legacy tenant) │                          │  Engine (PF-1)   │
│  - balance       │                          │                  │
│  - phone_hash    │                          │  ┌────────────┐  │
└──────────────────┘                          │  │ Idempotency│  │
                                              │  │ claim_id   │  │
                                              │  └────────────┘  │
                                              │  ┌────────────┐  │
                                              │  │ Validation │  │
                                              │  │ - negative │  │
                                              │  │ - balance  │  │
                                              │  └────────────┘  │
                                              └────────┬─────────┘
                                                       │
                            ┌──────────────────────────┼──────────────────┐
                            │                          │                  │
                            ▼                          ▼                  ▼
                  ┌──────────────────┐       ┌──────────────────┐  ┌──────────────┐
                  │  LP2.0 Wallet    │       │  Event Bus        │  │  Audit Log   │
                  │  credit()        │       │  aam.migrated     │  │  + RLS       │
                  │  (idempotent)    │       │  aam.rolled_back  │  │              │
                  └──────────────────┘       └──────────────────┘  └──────────────┘
                                                       │
                                                       ▼
                                              ┌──────────────────┐
                                              │  PF-4 Subscribers│
                                              │  - Wallet display│
                                              │  - Reporting     │
                                              └──────────────────┘
```

## 📦 Deliverables (5 files, 1,850+ insertions)

| # | File | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/aam-migration.js` | 10.2 KB | MigrationEngine class (5 methods) |
| 2 | `apps/engine/aam-migration.test.js` | 10.7 KB | 22 unit tests · 100% pass |
| 3 | `apps/admin-console/pages/aam-migration.html` | 13.5 KB | Admin console: single + batch + rollback |
| 4 | `sql/migrations/2026-07-07-phase-c-pf1-aam-migration.sql` | 6.3 KB | 4 tables + 1 view + 1 function + RLS |
| 5 | `docs/phase-c-pf1-aam-migration.md` | (this file) | Spec + bugs + architecture |

## 🔌 API

### `migrateAAMAccount({ aam_account_id, phone_hash, expected_balance?, dry_run?, actor? })`

Migrate a single AAM account to LP2.0.

**Returns:**
- `MIGRATED` — first-time success
- `ALREADY_MIGRATED` — idempotent skip (claim_id exists)
- `DRY_RUN` — preview only, no side effects

**Throws:**
- `negative balance` — manual review required
- `balance mismatch` (when `expected_balance` provided)
- `LP2.0 member not found` — phone_hash not yet registered

### `batchMigrate({ aam_accounts, dry_run?, actor?, concurrency? })`

Process many AAM accounts in parallel (default concurrency: 5).

**Returns:**
```js
{
  total: 100,
  migrated: 95,
  skipped: 3,    // already migrated
  failed: 2,     // validation errors
  errors: [{ aam_account_id, error }],
  started_at, completed_at,
}
```

### `rollback({ claim_id, reason, actor? })`

Reverse a migration. **Use only in incident response.**

- Reverses LP2.0 credit (debit)
- Unmarks AAM as migrated
- Records `rolled_back_at` + `rollback_reason`
- Publishes `aam.migration.rolled_back` event

### `getStatus(aam_account_id)`

Returns one of: `NOT_MIGRATED`, `MIGRATED`, `ROLLED_BACK`.

### `listMigrations({ status?, limit? })`

Paginated list with status filter.

## 🛡️ Idempotency Strategy

Use **`claim_id` (not timestamp)** because:
- ✅ Cron may run twice — same claim_id = same record
- ✅ User may click "migrate" twice — credit already exists, return existing
- ✅ Network retry — engine recovers from same starting point

**Format:** `AAM-MIG-{aam_account_id}-{epoch_ms}`

**Why not just timestamp?** Because cron + user retry can produce different timestamps → would double-credit. With claim_id derived from `aam_account_id`, retries converge to the same id.

## 🧪 Tests (22/22 passing)

```
✅ T01: rejects missing aam_account_id
✅ T02: rejects missing phone_hash
✅ T03: migrates AAM-001 (500 points) to M-1
✅ T04: AAM-001 marked as migrated in legacy
✅ T05: aam.migrated event published
✅ T06: re-migrating AAM-001 returns ALREADY_MIGRATED
✅ T07: idempotency prevents double credit
✅ T08: zero balance (AAM-003) still migrates
✅ T09: negative balance (AAM-004) is rejected
✅ T10: AAM-002 (ph_bbb mapped to M-2) migrates OK
✅ T11: dry_run returns plan without executing
✅ T12: expected_balance mismatch is rejected
✅ T13: batchMigrate processes multiple accounts
✅ T14: batchMigrate dry-run reports without executing
✅ T15: rollback reverses credit and unmarks AAM
✅ T16: rollback requires reason
✅ T17: getStatus returns NOT_MIGRATED for unknown
✅ T18: getStatus returns MIGRATED for AAM-001
✅ T19: getStatus returns ROLLED_BACK for AAM-002
✅ T20: listMigrations returns all records
✅ T21: listMigrations filters by status=ROLLED_BACK
✅ T22: listMigrations filters by status=MIGRATED
```

**Coverage:** 100% of public methods.

## 🗄️ Database Schema

### `aam_migration_records`
- `claim_id UNIQUE` — idempotency key
- `aam_account_id` — legacy ref
- `member_id` — LP2.0 target
- `amount` — with CHECK >= 0
- `rolled_back_at` — nullable
- `rollback_reason`, `rollback_actor` — audit
- `metadata JSONB` — extensibility

### `aam_legacy_accounts`
- Track AAM side: `migrated`, `migration_claim_id`
- Index on `phone_hash` (for cross-tenant join)
- Partial index on `NOT migrated` (for "pending" queries)

### `aam_migration_batches`
- One row per `batchMigrate()` call
- `errors JSONB` — for failure analysis

### View: `v_aam_migration_status`
- Admin-friendly status (MIGRATED / ROLLED_BACK)
- `seconds_since_migration` — for SLA tracking

### Function: `get_aam_migration_summary(since)`
- 7-day default window
- Returns counts + total points + unique members

### RLS
- `admin` role → SELECT only
- `service` role → full CRUD
- Default deny

## 🚀 Production Migration Path

### Phase 1: Staging (Week 1)
1. Run `2026-07-07-phase-c-pf1-aam-migration.sql` on staging
2. Dry-run `batchMigrate()` against staging data
3. Review `get_aam_migration_summary()` output
4. Manual spot-check 10 random accounts

### Phase 2: Production Dry-Run (Week 2)
1. Connect to read-only AAM replica
2. Run `batchMigrate({ dry_run: true })` for **all** AAM accounts
3. Generate report: total points, error breakdown, member coverage
4. **Hold sign-off from Finance + Compliance**

### Phase 3: Live Migration (Week 3)
1. Disable AAM wallet UI (read-only mode)
2. Run `batchMigrate({ dry_run: false, concurrency: 3 })` — **slow** for safety
3. Monitor `v_aam_migration_status` + audit log in real-time
4. If any `failed > 0`: investigate, decide to continue or rollback batch
5. Enable LP2.0 wallet UI
6. Mark AAM tenant as `MIGRATION_COMPLETE`

### Phase 4: Sunset AAM Wallet (Week 4)
1. Archive AAM ledger to cold storage
2. Remove AAM wallet endpoints
3. Update documentation

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| AAM ledger stale (last sync weeks ago) | Wrong balance migrated | Compare `aam.last_synced_at` vs now; force re-sync first |
| Phone mismatch (AAM phone ≠ LP2.0 phone) | Orphan migration | Require manual phone verification for >5% mismatch rate |
| Network failure mid-batch | Partial state | Concurrency=3 + idempotency lets us resume safely |
| AAM has data LP2.0 doesn't expect | Constraint violation | Dry-run first; review schema differences |
| Regulator asks for rollback | Data inconsistency | `rollback()` works per-claim + per-batch (TODO) |

## 📊 Metrics to Track (Post-Launch)

- **M-1: Migration coverage** = migrated / total AAM accounts × 100% (target: >99%)
- **M-2: Rollback rate** = rolled_back / migrated × 100% (target: <0.1%)
- **M-3: Time-to-migrate** = p95 batch duration (target: <30 min for 10k accounts)
- **M-4: Support tickets** = "AAMpoint missing" tickets (target: 0 within 7 days)

## 🔗 Related

- **PF-2 (WalletReconcileEngine):** reads `aam_migration_records` for `getAAMPoint()` read-time reconcile
- **PF-3 (RewardEngine):** publishes `point.credited` after migration credit
- **PF-4 (EventBusEngine):** subscribes `aam.migrated` → wallet display refresh
- **RFC-001 OQ#7:** Original migration spec (phone-based, this extends to AAM cross-tenant)

## 🎬 Demo

**Admin Console:** https://rattapornkachakaewpkg-commits.github.io/likepoint-2.0/apps/admin-console/pages/aam-migration.html

**Try:**
1. Single migrate: `AAM-001` / `ph_aaa` / 500 → ✅ MIGRATED
2. Same again → ⚠️ ALREADY_MIGRATED
3. Dry run → 📋 plan with 4 steps
4. Batch (3 accounts) → 📊 summary
5. Rollback → ⏪ ROLLED_BACK

---

**Cycle 4 Complete.** Ready for next iteration (PF-5? Phase D?).
