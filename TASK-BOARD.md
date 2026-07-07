# 📋 TASK-BOARD — LikePoint 2.0

**Last Updated:** 2026-07-07
**Maintainer:** AliClaw + Dev Team
**Version:** 1.0
**Format:** Consolidated (จากหลายไฟล์ → จุดเดียว)

---

## 🎯 วิธีอ่าน

| Column | ความหมาย |
|---|---|
| **ID** | TASK-001, TASK-002 ... |
| **Priority** | 🔴 P0 (Critical) / 🟡 P1 (High) / 🟢 P2 (Medium) / ⚪ P3 (Low) |
| **Effort** | XS (1-2 วัน) / S (3-5 วัน) / M (1-2 สัปดาห์) / L (2-4 สัปดาห์) |
| **Status** | ⬜ Not Started / 🟡 In Progress / ✅ Done / 🚫 Blocked |
| **Source** | เอกสารต้นฉบับที่อธิบายงานนี้ |

---

## 🚨 P0: CRITICAL (ทำก่อน — Block Production)

### Wallet & Identity

| ID | Task | Priority | Effort | Status | Source |
|---|---|---|---|---|---|
| TASK-001 | แก้ปัญหา Wallet Duplicate (UNIQUE constraint + Race Condition Lock) | 🔴 P0 | M | ⬜ | `root-cause-wallet-duplicate.md` |
| TASK-002 | สร้าง Idempotency Key สำหรับ Transaction API | 🔴 P0 | S | ⬜ | `root-cause-wallet-duplicate.md` |
| TASK-003 | Migration: Legacy phone-based → UUID (MS24↔Mini Like↔PP7) | 🔴 P0 | L | ⬜ | `04-ms24-minilike-pp7-integration.md` (PF-1) |
| TASK-004 | Implement Wallet Rebinding Engine (auto-rebind on phone change) | 🔴 P0 | M | ⬜ | `04-*.md` (PF-2) |
| TASK-005 | Event-Driven Architecture: MS24 → SQS → Mini Like | 🔴 P0 | L | ⬜ | `04-*.md` (PF-4) |

### Security (PDPA)

| ID | Task | Priority | Effort | Status | Source |
|---|---|---|---|---|---|
| TASK-006 | Audit log retention 7 ปี (PDPA compliance) | 🔴 P0 | S | ⬜ | `COMPLIANCE_CHECKLIST.md` |
| TASK-007 | Consent Management: Record + Revoke API | 🔴 P0 | S | ⬜ | `04-*.md` (Tenant Service) |
| TASK-008 | Phone masking (08x-xxx-xxxx) ในทุก API response | 🔴 P0 | XS | ⬜ | `COMPLIANCE_CHECKLIST.md` |

---

## 🟡 P1: HIGH (Phase A Quick Win — 1-2 สัปดาห์)

### Admin Console

| ID | Task | Priority | Effort | Status | Source |
|---|---|---|---|---|---|
| TASK-101 | Admin Recovery Tool (MSP Recovery page) | 🟡 P1 | S | ✅ Done | `phase-a-implementation.md` |
| TASK-102 | Customer 360 view (L1-L4 tabs) | 🟡 P1 | S | ⬜ | `03-admin-console-design.md` |
| TASK-103 | Merge Account UI (3-step wizard) | 🟡 P1 | M | ⬜ | `03-admin-console-design.md` |
| TASK-104 | Transfer Point UI (Finance Approval) | 🟡 P1 | M | ⬜ | Master Report Tab 7 REQ-2 |
| TASK-105 | Identity Resolution Queue (approve auto-merge) | 🟡 P1 | M | ⬜ | `03-admin-console-design.md` |
| TASK-106 | Audit Log Viewer (filterable) | 🟡 P1 | S | ⬜ | `03-admin-console-design.md` |
| TASK-107 | RBAC Middleware (3 roles enforcement) | 🟡 P1 | S | ⬜ | `03-admin-console-design.md` |

### Form & Workflow

| ID | Task | Priority | Effort | Status | Source |
|---|---|---|---|---|---|
| TASK-108 | เปลี่ยนฟอร์มซื้อ Point (input THB → calc BUpoint+LAK+USD) | 🟡 P1 | XS | ✅ Done | Master Report Tab 7 REQ-1 |
| TASK-109 | Risk-based BCT Distribution (Low/Med/High) | 🟡 P1 | M | ✅ Schema | `phase-a-implementation.md` |
| TASK-110 | BCT Hold Queue (high-risk auto-hold) | 🟡 P1 | S | ✅ Schema | `phase-a-implementation.md` |

---

## 🟢 P2: MEDIUM (Phase B Permanent — 1 ไตรมาส)

### Multi-phone & Device

| ID | Task | Priority | Effort | Status | Source |
|---|---|---|---|---|---|
| TASK-201 | Multi-phone Support (1 member → 5 phones) | 🟢 P2 | M | ✅ Engine | `04-*.md` (OQ #2) |
| TASK-202 | Device Binding (max 10 devices + suspicious detection) | 🟢 P2 | M | ✅ Engine | `04-*.md` (OQ #3) |

### Security & Auth

| ID | Task | Priority | Effort | Status | Source |
|---|---|---|---|---|---|
| TASK-203 | Multi-Factor Authentication (TOTP + SMS) | 🟢 P2 | M | ✅ Engine | `04-*.md` (OQ #5) |
| TASK-204 | Identity Resolution (Levenshtein + multi-signal) | 🟢 P2 | M | ✅ Engine | `04-*.md` (OQ #4) |
| TASK-205 | Account Recovery Flow (4-step) | 🟢 P2 | S | ✅ Engine | `04-*.md` (OQ #10) |

### Cross-Feature

| ID | Task | Priority | Effort | Status | Source |
|---|---|---|---|---|---|
| TASK-206 | Cross-Tenant Point Transfer | 🟢 P2 | M | ✅ Engine | `04-*.md` (OQ #6) |
| TASK-207 | Tenant Service (CRM + Campaign + Consent) | 🟢 P2 | L | ✅ Engine | Constitution v0.2 |
| TASK-208 | KYC Integration (LEVEL_0/1/2) | 🟢 P2 | M | ✅ Engine | `04-*.md` (OQ #9) |
| TASK-209 | Notification Service (SMS/Email/Push) | 🟢 P2 | S | ✅ Engine | `04-*.md` (OQ #11) |
| TASK-210 | Reporting & Analytics (Success Metrics) | 🟢 P2 | M | ✅ Engine | `04-*.md` (OQ #8) |
| TASK-211 | Migration Engine (backward compat) | 🟢 P2 | M | ✅ Engine | `04-*.md` (OQ #7) |

---

## ⚪ P3: LOW (Phase C Optimize — หลัง Launch)

| ID | Task | Priority | Effort | Status | Source |
|---|---|---|---|---|---|
| TASK-301 | Performance Optimization (Cache + CDN) | ⚪ P3 | M | ⬜ | `modernization-plan.html` |
| TASK-302 | Scale to 1M users (Sharding) | ⚪ P3 | L | ⬜ | `executive-summary.md` (P5) |
| TASK-303 | DR Site (Multi-region) | ⚪ P3 | L | ⬜ | `executive-summary.md` (P5) |
| TASK-304 | Real-time Dashboard (WebSocket) | ⚪ P3 | M | ⬜ | Roadmap |
| TASK-305 | Open API (Public) | ⚪ P3 | M | ⬜ | RFC-001 §7 |
| TASK-306 | Mobile App (iOS + Android) | ⚪ P3 | L | ⬜ | RFC-001 §9 |

---

## 📊 Dependency Graph

```
TASK-001 (Wallet Duplicate) ─┐
                              ├─→ TASK-003 (Migration) ─→ TASK-005 (Event Bus) ─→ Production
TASK-002 (Idempotency)    ─┘
TASK-004 (Rebind Engine)  ─→ TASK-110 (Hold Queue) ─→ Phase A Complete

TASK-101 (Recovery Tool)  ─→ TASK-102-106 (Admin Pages) ─→ Phase A Complete
TASK-108 (Buy Form)       ─→ TASK-109 (Risk BCT)   ─→ Phase A Complete

TASK-201-211 (All Engines) ─→ Phase B Complete (Implementation Ready ✅)
```

---

## 🏃 Sprint Plan (แนะนำ)

### Sprint 1 (Week 1-2): Phase A Quick Win
- TASK-101, TASK-102, TASK-103, TASK-104, TASK-105, TASK-106, TASK-107
- TASK-108, TASK-109, TASK-110
- **Outcome:** Admin ทำงานได้เอง 80% (ไม่ต้องรอ Dev)

### Sprint 2 (Week 3-4): Phase A + B Foundation
- TASK-001, TASK-002, TASK-004, TASK-006, TASK-007, TASK-008
- **Outcome:** Production-ready (ไม่มี wallet duplicate)

### Sprint 3 (Week 5-8): Phase B Permanent
- TASK-003, TASK-005, TASK-201-211
- **Outcome:** RFC-001 100% compliance

### Sprint 4+ (Week 9+): Phase C Optimize
- TASK-301-306 (ตาม Priority)

---

## 📈 Progress Tracker

| Phase | Total Tasks | Done | In Progress | % |
|---|---|---|---|---|
| P0 (Critical) | 8 | 0 | 0 | 0% |
| P1 (Phase A) | 10 | 3 | 0 | 30% |
| P2 (Phase B) | 11 | 11 | 0 | **100%** ✅ |
| P3 (Phase C) | 6 | 0 | 0 | 0% |
| **Total** | **35** | **14** | **0** | **40%** |

---

## 🔗 Quick Links

- **Master Report:** [likepoint-2-master-report.html](../audit/likepoint-2-master-report.html)
- **Constitution:** [constitution-v0.2.md](../docs/constitution-v0.2.md)
- **Phase A Spec:** [phase-a-implementation.md](../docs/phase-a-implementation.md)
- **MS24↔Mini Like↔PP7:** [04-ms24-minilike-pp7-integration.md](../enterprise-redesign/md/04-ms24-minilike-pp7-integration.md)
- **Admin Console Design:** [03-admin-console-design.md](../enterprise-redesign/md/03-admin-console-design.md)
- **INDEX:** [../../INDEX.md](../../INDEX.md)

---

## 🆘 How to Update This Board

1. Update Status: `⬜ Not Started` → `🟡 In Progress` → `✅ Done`
2. Add new task: Get next ID (TASK-307, TASK-308, etc.)
3. Update Progress Tracker
4. Notify AliClaw if blocked (>3 days)

---

**Last Sprint Review:** 2026-07-07 by AliClaw
**Next Review:** 2026-07-14
