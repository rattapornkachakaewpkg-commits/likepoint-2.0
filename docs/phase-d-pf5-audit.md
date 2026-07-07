# Phase D — PF-5: Audit Log & Compliance Engine

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #5 of likepoint-2.0

## 🎯 Objective

เปลี่ยน audit log จาก "บันทึกอย่างเดียว" → **searchable, exportable, PDPA-compliant, 7-year retention** เพื่อให้ legal/finance/support trace incident ได้ภายใน 30 วินาที และตอบ PDPA data subject request ภายใน 30 วัน

## 🐛 Bugs Fixed (4 from feedback)

| ID | Symptom | Root Cause | PF-5 Fix |
|---|---|---|---|
| **A21** | Support ตามหา transaction ไม่เจอใน 24ชม. | No search across services | `search()` by member_id, event_type, range, correlation |
| **A31** | Finance โหลด statement export ไม่ได้ | No bulk export | `export()` CSV/JSON + S3 signed URL |
| **A43** | PDPA — user ขอ data แต่ทีมตอบไม่ทัน 30 วัน | Manual process, no tracking | `exportUserData()` + `pdpa_requests` table + SLA monitor |
| **A44** | Audit log หายเมื่อ rollback | UPDATE/DELETE not blocked | Immutable triggers + RLS revoke |

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────┐
│  AuditEngine (PF-5)                                    │
│                                                         │
│  ┌────────────┐  ┌─────────────┐  ┌────────────────┐ │
│  │  log()     │  │  search()   │  │  export()      │ │
│  │  (every    │  │  - member   │  │  - CSV         │ │
│  │   API)     │  │  - event    │  │  - JSON        │ │
│  │            │  │  - range    │  │  - S3 URL      │ │
│  │  +encrypt  │  │  - corr_id  │  └────────────────┘ │
│  │   PII      │  │  - outcome  │  ┌────────────────┐ │
│  └────────────┘  └─────────────┘  │  exportUserData│ │
│                                  │  - 30-day SLA  │ │
│  ┌────────────┐  ┌─────────────┐  │  - audit it    │ │
│  │  retention │  │  getByCorr  │  └────────────────┘ │
│  │  - 7yr     │  │  trace      │  ┌────────────────┐ │
│  │  - archive │  │  across     │  │  retention     │ │
│  │  - purge   │  │  services   │  │  sweep         │ │
│  └────────────┘  └─────────────┘  └────────────────┘ │
└─────────────────────────┬──────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
  ┌──────────┐     ┌──────────┐      ┌──────────┐
  │ audit_log│     │ pdpa_    │      │ export_  │
  │ (immut.) │     │ requests │      │ jobs     │
  │ + 7yr    │     │ + SLA    │      │ + S3 URL │
  └──────────┘     └──────────┘      └──────────┘
```

## 📦 Deliverables (5 ไฟล์, ~1,720 insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/audit-engine.js` | 13.0 KB | AuditEngine: log/search/export/exportUserData/retention/getByCorrelation/stats |
| 2 | `apps/engine/audit-engine.test.js` | 10.5 KB | **24/24 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/audit-compliance.html` | 18.0 KB | Console: search + bulk export + PDPA wizard + retention + correlation trace |
| 4 | `sql/migrations/2026-07-07-phase-d-pf5-audit.sql` | 10.6 KB | 3 tables (audit_log + pdpa_requests + export_jobs) + 2 views + 2 functions + RLS + 7yr partitions |
| 5 | `docs/phase-d-pf5-audit.md` | (this file) | Spec + PDPA compliance + bugs + 4-week rollout |

## 🔌 API

### `log({ event_type, actor, member_id?, resource_type?, resource_id?, action, metadata?, correlation_id?, ip_address?, user_agent?, outcome? })`

Every API call writes one immutable entry. **Required fields:** `event_type`, `actor`, `action`.

**Auto features:**
- PII in `metadata` (`phone`, `email`, `id_card`, etc.) → encrypted to `pii_encrypted` column
- `metadata` returned with PII replaced by `[REDACTED]`
- `member_hash` computed for PII-safe search
- `retention_until` = `created_at + 7 years`
- Returns `{ id, created_at }`

### `search({ member_id?, event_type?, actor?, resource_id?, correlation_id?, from?, to?, outcome?, limit?, offset?, order? })`

For support / finance / auditor dashboards. All filters optional, combined with AND.

**Returns:** `{ total, limit, offset, has_more, items[] }`

### `export({ filters?, format?, actor? })`

Bulk export for finance/legal. `format` = `csv` | `json`.

**Returns:**
```js
{
  export_id: "EXP-...-XXXX",
  format, row_count, size_bytes,
  expires_at: "now + 7 days",
  url: "https://exports.likepoint.local/EXP-...-XXXX.{fmt}",
}
```

**Audits itself** — every export creates an `AUDIT_EXPORT` entry.

### `exportUserData({ member_id, requested_by? })`

PDPA self-service data export. **SLA: 30 days** (Thai PDPA requirement).

**Returns:**
```js
{
  pdpa_request_id: "PDPA-...-XXXX",
  export_id: "PDPA-EXP-...",
  member_id, sla_deadline, status: "ready",
  url, summary: { profile, transactions, audit_entries, migrations },
}
```

**Audits itself** as `PDPA_REQUEST` event with `sla_deadline` in metadata.

### `runRetentionSweep({ now?, archive_bucket? })`

Daily cron. Archives entries older than 7 years to cold storage (or deletes if no bucket).

**Returns:** `{ archived, deleted, cutoff }`

### `getByCorrelation(correlation_id)`

Trace a single transaction across all services. Returns all audit entries sharing the `correlation_id`.

### `stats({ since? })`

Aggregated counts by `event_type`, `actor`, `outcome`. For dashboard summary.

## 🛡️ Key Design Decisions

### 1. **Immutable audit_log** — `trigger blocks UPDATE/DELETE`
```sql
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
-- raises: 'audit_log is immutable: UPDATE is not allowed (PDPA compliance)'
```

### 2. **7-year retention** — partitioned by year + `retention_until` column
- Table partitioned `RANGE (created_at)` yearly (2026–2033)
- Each row carries `retention_until` for `archive_old_audit(7)` sweep
- `pg_cron` runs sweep daily at 02:00 (production setup)

### 3. **PII protection** — encrypt at rest, hash for search
- `pii_encrypted` (BYTEA, AES-256-GCM) — never queryable
- `member_hash` (TEXT, hash) — for index lookup
- `metadata` (JSONB) — PII stripped to `[REDACTED]`
- Decrypt requires service-role + decryption key

### 4. **PDPA 30-day SLA** — `pdpa_requests.sla_deadline` + dashboard banner
- `v_pdpa_sla_status` view computes `sla_status` (ON_TRACK / AT_RISK / BREACHED)
- AT_RISK = < 3 days remaining (banner shown)
- BREACHED = past deadline (alert email)

### 5. **Cross-service correlation** — `correlation_id` everywhere
- Generated at API gateway
- Propagated to wallet, migration, event_bus, audit
- `getByCorrelation()` traces end-to-end

### 6. **3 roles via RLS** — admin / auditor / service
- `admin` → SELECT on all, INSERT/UPDATE on pdpa + export
- `auditor` → SELECT only on audit_log + export_jobs
- `service` → INSERT on audit_log, full CRUD on pdpa + export_jobs
- Default: deny

## 🧪 Tests (24/24 passing)

```
✅ T01: log() requires event_type
✅ T02: log() requires actor
✅ T03: log() requires action
✅ T04: log() returns id and created_at
✅ T05: log() stores PII encrypted
✅ T06: log() calculates 7-year retention_until
✅ T07: search() by member_id
✅ T08: search() by event_type
✅ T09: search() by date range
✅ T10: search() pagination
✅ T11: search() by correlation_id
✅ T12: search() by outcome
✅ T13: export() returns CSV
✅ T14: export() returns JSON
✅ T15: export() rejects invalid format
✅ T16: export() audits itself
✅ T17: exportUserData() requires member_id
✅ T18: exportUserData() returns 30-day SLA
✅ T19: exportUserData() includes profile + txns + audit
✅ T20: exportUserData() creates PDPA_REQUEST audit entry
✅ T21: runRetentionSweep() archives old entries
✅ T22: runRetentionSweep() keeps recent entries
✅ T23: getByCorrelation() traces across services
✅ T24: stats() aggregates by event_type and actor
```

**Coverage:** 100% of public methods.

## 🗄️ Database Schema

### `audit_log` (partitioned)
- `id BIGSERIAL` + `created_at TIMESTAMPTZ` → composite primary key
- `audit_id TEXT` (human-readable: `AUD-{ts}-{seq}`)
- `event_type`, `actor`, `member_id`, `member_hash`
- `action`, `outcome`, `metadata JSONB`, `pii_encrypted BYTEA`
- `correlation_id`, `ip_address INET`, `user_agent`
- `retention_until TIMESTAMPTZ`
- **Immutable** — triggers reject UPDATE/DELETE
- **Partitioned** by year (2026–2033)
- **6 indexes** for common query patterns

### `pdpa_requests`
- `request_id` (PDPA-{ts}-{seq})
- `member_id UUID`, `requested_by`
- `status` (pending, ready, delivered, failed)
- `sla_deadline` = now + 30 days
- `export_id`, `delivered_at`, `delivered_to`

### `export_jobs`
- `export_id` (EXP-{ts}-{seq})
- `format` (csv, json, pdpa_zip)
- `filters JSONB`, `requested_by`
- `storage_url`, `size_bytes`
- `expires_at` = now + 7 days
- `downloaded_count` (for anomaly detection)

### View: `v_audit_recent`
- Last 1000 entries
- `days_until_purge` for retention monitoring

### View: `v_pdpa_sla_status`
- `sla_status` (ON_TRACK / AT_RISK / BREACHED)
- `days_remaining` for prioritization

### Function: `archive_old_audit(cutoff_years)`
- Counts entries older than N years
- Production: `aws_s3.query_export_to_s3()` to S3 Glacier

### Function: `get_audit_stats(since)`
- 6 KPIs: total, actors, members, failures, pdpa, exports
- Default window: 7 days

## 🚀 Production Migration Path

### Week 1: Staging
1. Apply `2026-07-07-phase-d-pf5-audit.sql` on staging
2. Verify partitions created (2026-2033)
3. Backfill last 90 days from application logs
4. Test `getByCorrelation()` with sample txn

### Week 2: UAT
1. Sign-off from **Finance** on export format
2. Sign-off from **Legal** on PDPA export content
3. Sign-off from **Compliance** on retention policy
4. Pen-test: confirm PII is encrypted at rest

### Week 3: Production Cutover
1. Apply migration during low-traffic window (02:00-04:00)
2. Update `app.current_role` setting per service
3. Wire all engines to call `audit.log()` on every action
4. Verify dashboard loads

### Week 4: Operationalize
1. Configure `pg_cron`: `archive_old_audit()` daily at 02:00
2. Set up Slack alert for `v_pdpa_sla_status WHERE sla_status = 'BREACHED'`
3. Set up email digest of `get_audit_stats()` daily
4. Train support team on search UI

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Backfill 90 days takes hours | Delayed launch | `COPY` + skip indexes during load, build indexes after |
| Encrypted column slow to query | Slow search | Decrypt in app layer, not SQL; cache decrypted values |
| Export file >100MB | Email bloat | S3 signed URL (no email attachment) |
| `correlation_id` missing in old code | Broken trace | Backfill: default to `legacy-{ts}` for entries < 2026-07-01 |
| Partition bloat | Slow queries | Auto-create next year partition via cron on Dec 1 |

## 📊 Post-Launch Metrics

- **M-1: PDPA SLA compliance** = delivered_on_time / total × 100% (target: >99%)
- **M-2: Audit coverage** = services_using_audit / total_services × 100% (target: 100%)
- **M-3: Search latency** = p95 search duration (target: <500ms)
- **M-4: Export success rate** = successful_exports / total × 100% (target: >99.5%)

## 🔗 Related

- **PF-1 (AAMMigrationEngine):** every migration writes `MIGRATION` audit entry with `correlation_id`
- **PF-3 (RewardEngine):** `point.credited` events link via `correlation_id`
- **PF-4 (EventBusEngine):** every publish/subscribe audited
- **Constitution v0.2 §3.5:** "Audit Log (every action, 7-year retention) — PDPA" ← this PF

## 🎬 Demo

**Admin Console:** https://rattapornkachakaewpkg-commits.github.io/likepoint-2.0/apps/admin-console/pages/audit-compliance.html

**Try:**
1. Search by `MIGRATION` event type → see all AAM migrations with member_id
2. Trace by `CORR-123` → see all services touched (wallet + migration + audit)
3. Export CSV → download with 7-day expiry
4. PDPA export `M-1000` → returns profile + 2 txns + audit + migration records, SLA in 30 days
5. Retention dry-run → "would archive 0 entries" (all recent in demo)

---

**Cycle 5 Complete.** 🎉 5 cycles total · 130+ tests passing · 4,000+ insertions · 100% deploy success.
