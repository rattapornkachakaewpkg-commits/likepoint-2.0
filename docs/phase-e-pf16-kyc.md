# Phase E — PF-16: KYC Engine (Level 2/3 Manual Review)

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #16 of likepoint-2.0

> **"LEVEL_2 (manual review)"** — Constitution v0.2 §3.4
> KYC Level 2 = required for B2B (Pro/Enterprise merchants)

## 🎯 Objective

Complete KYC compliance with **manual review queue** for Level 2/3 applications — required for B2B merchants (Pro/Enterprise tier) and high-value members

## 🏗️ Architecture

```
User submits KYC L2
  ↓
Upload documents (business_license, tax_id, id_card, bank_statement)
  ↓
Auto-assign to reviewer (round-robin)
  ↓
Reviewer:
  ├── Approve → upgrade tier to pro/enterprise
  ├── Reject → notify user with reason
  └── Request More Info → extend SLA by 24h
  ↓
Audit + notify via PF-5 + PF-15
```

## 📦 Deliverables (5 ไฟล์, ~1,500+ insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/kyc-engine.js` | 15.2 KB | KYCEngine: 10 methods (submit/upload/approve/reject/requestMoreInfo/getStatus/getQueue/addReviewer + 2 list) |
| 2 | `apps/engine/kyc-engine.test.js` | 9.4 KB | **23/23 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/kyc-console.html` | 12.3 KB | Submit + reviewer queue + decision form |
| 4 | `sql/migrations/2026-07-07-phase-e-pf16-kyc.sql` | 9.0 KB | 4 tables (reviewers + applications + documents + reviews) + 1 view + RLS |
| 5 | `docs/phase-e-pf16-kyc.md` | (this file) | Spec + flow + 4-week rollout |

## 🔌 API Design

### `submitApplication({ member_id, level, business_name?, business_license?, tax_id?, metadata? })`

Submit KYC application.

**Levels:** 2 (Pro, 48h SLA) or 3 (Enterprise, 72h SLA)

**Returns:** Application with auto-assigned reviewer + SLA deadline

**Auto-rejects duplicate pending** applications for same member+level.

### `uploadDocument({ application_id, document_type, file_name, file_url, file_size_bytes?, mime_type? })`

Upload supporting documents.

**Document types:** `business_license`, `tax_id`, `id_card`, `bank_statement`, `address_proof`, etc.

### `approve({ application_id, reviewer_id, notes? })`

Reviewer approves → member tier upgraded to `pro` (L2) or `enterprise` (L3).

### `reject({ application_id, reviewer_id, reason })`

Reviewer rejects. **Reason required** (for audit + notify).

### `requestMoreInfo({ application_id, reviewer_id, message })`

Ask applicant for more documents → **extends SLA by 24h**.

### `getStatus(member_id)` — applicant view

Returns latest application + documents + decision.

### `getReviewerQueue({ reviewer_id?, status?, limit? })` — reviewer view

Sorted by SLA deadline (urgent first).

### `addReviewer({ reviewer_id, name, email, specializations? })` — admin

Add a reviewer to the pool.

### `getStats({ since?, reviewer_id? })`

Analytics: pending/approved/rejected/more_info + SLA breaches + approval rate.

## 🛡️ Key Design Wins

### 1. **4-level KYC** (matches Constitution)
- Level 0/1: auto (existing kyc.js stub)
- **Level 2: manual review (this PF)**
- **Level 3: full KYC (also this PF)**
- Tier upgrade: free → pro (L2) / enterprise (L3)

### 2. **Round-robin reviewer assignment**
- Auto-assign on submit (no manual queue management)
- Fair workload distribution
- No reviewer stuck with all apps

### 3. **SLA tracking with breach detection**
- L2: 48h, L3: 72h
- More-info extends +24h
- `v_kyc_pending_queue` view shows BREACHED/URGENT/WARNING/NORMAL

### 4. **Document upload + file metadata**
- `file_name`, `file_url` (S3 in production), `file_size_bytes`, `mime_type`
- Multiple docs per application
- ON DELETE CASCADE (clean up when app deleted)

### 5. **Auto-notify via PF-15**
- Reviewer: assigned notification
- Applicant: approved/rejected/more_info notification
- All audit-logged via PF-5

### 6. **Audit via PF-5 (6 events)**
- `KYC_APPLICATION_SUBMITTED`, `KYC_APPLICATION_ASSIGNED`, `KYC_APPLICATION_APPROVED`, `KYC_APPLICATION_REJECTED`, `KYC_MORE_INFO_REQUESTED`, `KYC_DOCUMENT_UPLOADED`
- Full traceability for compliance

### 7. **Multi-role RLS**
- `member` → see own applications
- `reviewer` → see/edit assigned applications
- `admin` → all
- `service` → full CRUD (for auto-tasks)

## 🧪 Tests (23/23 passing)

```
✅ submitApplication (5): required, level validation, success, dup, L3 SLA
✅ uploadDocument (3): required, success, approved rejection
✅ approve / reject / requestMoreInfo (5): tier upgrade, reason, SLA ext, assigned-only
✅ getStatus (2): no app, with docs
✅ getReviewerQueue (2): filter by reviewer, sort by SLA
✅ addReviewer (1): validation
✅ getStats (2): counts, SLA breaches
✅ Round-robin (1): alternates
✅ Events (2): publish, notification
```

## 🗄️ Database Schema

### `kyc_reviewers`
- `reviewer_id TEXT UNIQUE`, `name`, `email`
- `specializations JSONB` (business/tax/banking)
- `active BOOLEAN`, `status`, `added_at`, `last_assigned_at`

### `kyc_applications`
- `application_id TEXT UNIQUE` (KYC-{ts}-{seq})
- `member_id UUID`, `level` (2|3)
- `business_name`, `business_license`, `tax_id`
- `status` (pending/in_review/more_info_required/approved/rejected)
- `assigned_reviewer_id FK`, `submitted_at`, `sla_deadline`
- `reviewed_at`, `reviewed_by`, `decision`, `decision_reason`
- **Unique:** `(member_id, level)` where pending/in_review/more_info (prevent dup)

### `kyc_documents`
- `document_id TEXT UNIQUE` (DOC-{ts}-{seq})
- `application_id FK` (CASCADE delete)
- `document_type`, `file_name`, `file_url`
- `file_size_bytes`, `mime_type`

### `kyc_reviews`
- `review_id TEXT UNIQUE` (REV-{ts}-{seq})
- `application_id FK` (CASCADE)
- `reviewer_id FK`, `decision` (approved/rejected/more_info_required)
- `notes`, `reviewed_at`

### View: `v_kyc_pending_queue`
- Pending applications + `hours_until_sla` + `sla_status` (BREACHED/URGENT/WARNING/NORMAL) + document count

### Function: `get_kyc_stats(since)`
- Single-call: total/pending/approved/rejected/more_info + SLA breaches + approval rate

### RLS (4 roles)
- `member` → own applications
- `reviewer` → assigned applications
- `admin` → all
- `service` → full CRUD

## 🆚 vs Constitution v0.2 §3.4

| Level | Method | This PF? |
|---|---|---|
| LEVEL_0 | auto (email only) | ✅ (kyc.js stub) |
| LEVEL_1 | auto (email + phone) | ✅ (kyc.js stub) |
| **LEVEL_2** | **manual review** | **✅ THIS PF** |
| **LEVEL_3** | **full KYC + compliance** | **✅ THIS PF** |

## 🔗 Integration with Other PFs

- **PF-5 (AuditEngine):** all KYC events audited
- **PF-6 (MerchantEngine):** merchants require L2 for Pro/Enterprise tier
- **PF-9 (Subscription):** Pro/Enterprise tier unlocks after L2/L3 approval
- **PF-14 (SessionGuard):** all KYC endpoints protected
- **PF-15 (Notification):** auto-notify reviewer + applicant
- **PF-1 (AAM Migration):** AAM members may need L2 if value > threshold

## 🐛 Bugs Closed (Indirect)

- **B18** (KYC Level 2 missing) → Constitution v0.2 requirement now met
- **B22** (no manual review queue) → built

## 🚀 Production Rollout (4 weeks)

### Week 1: Staging + reviewers
1. Apply migration on staging
2. Add 3-5 KYC reviewers (Alice, Bob, Carol)
3. Internal pilot: 5 PKG staff submit L2
4. Verify: SLA tracking, notification, audit

### Week 2: UAT with 20 SMEs
1. 20 SME merchants submit L2 (Pro tier requirement)
2. Test: full flow (submit → review → approve → tier upgrade)
3. Monitor: approval rate, SLA breaches, document issues

### Week 3: Public launch
1. Open L2 to all Pro/Enterprise tier applicants
2. Marketing: "ยืนยันตัวตน KYC Level 2 ใช้เวลา 48 ชม."
3. Add L3 for high-value merchants

### Week 4: Optimization
1. Auto-prioritize (L3 > L2, repeat applicant > first-time)
2. Reviewer dashboard (avg review time)
3. SLA prediction (ML model: "likely to breach in 12h")

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Reviewer overloaded | SLA breach | Round-robin + auto-reassign if no reviewer |
| Fake documents | Compliance risk | Manual review (human eyes) + cross-check business registry |
| Reviewer bias | Fairness | Random review order + audit + multiple reviewers for L3 |
| Document leak | Privacy | RLS (only assigned reviewer) + audit log all access |
| PII in logs | Compliance | Don't log document content, only IDs + audit access |
| SLA always breached | Bad UX | Add more reviewers, auto-escalate to admin |

## 📊 Success Metrics

- **M-1: SLA compliance** = on_time / total (target: >80%)
- **M-2: Approval rate** = approved / decided (target: 60-80%, not 100% = quality control)
- **M-3: Avg review time** = reviewed_at - submitted_at (target: <24h)
- **M-4: Document rejection rate** = rejected_for_docs / total (target: <20%)
- **M-5: Repeat applicants** (more_info_required → resubmit) (target: <30%)

## 🔗 Related PFs

- **PF-5 (AuditEngine):** KYC events audited
- **PF-6 (MerchantEngine):** tier upgrade flow
- **PF-9 (Subscription):** Pro/Enterprise features unlock
- **PF-14 (SessionGuard):** protected KYC endpoints
- **PF-15 (Notification):** reviewer + applicant alerts

## 🎬 Demo

**Console:** `https://likepoint-2.0.pages.dev/apps/admin-console/pages/kyc-console.html`

**Try:**
1. Submit application as M-1, Level 2, Bangkok Cafe → assigned to R-1 (SLA 48h)
2. Switch to Reviewer Queue → see your app
3. Click "Open" → submit decision
4. Choose Approve + notes "all good" → status: approved
5. Submit another + Reject + reason "docs unclear" → status: rejected
6. Submit + More Info + message "need tax" → SLA extends 24h

---

**Cycle 16 Complete.** 🎉 16 cycles · 445 tests · ~28,150 insertions · 100% deploy success.
