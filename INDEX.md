# 📑 LikePoint 2.0 — Project Index

**Last Updated:** 2026-07-07
**Maintainer:** AliClaw (AI Co-Worker) + แนน (HRD Manager)

---

## 🎯 เอกสารหลัก (Master Documents)

| # | ไฟล์ | คำอธิบาย | URL |
|---|---|---|---|
| 1 | **Constitution v0.2** | เอกสารหลักของ Platform (RFC-001 100% compliance) | [constitution-v0.2.md](docs/constitution-v0.2.md) |
| 2 | **RFC-001: Canonical Identity Architecture** | สถาปัตยกรรม Identity (Accepted 2026-07-06) | [04-ms24-minilike-pp7-integration.md](../projects/likepoint-2/enterprise-redesign/md/04-ms24-minilike-pp7-integration.md) |
| 3 | **Master Report** | รายงานรวม (7 tabs × 4 audiences) | [likepoint-2-master-report.html](../projects/likepoint-2/audit/likepoint-2-master-report.html) |

---

## 🏗️ Architecture (RFC-001 + Constitution)

### Core Services
- **Identity Service** — Member ID (UUID) + Profile + Status + KYC
- **Wallet Service** — Wallet + Point + Transactions
- **Tenant Service** — CRM + Campaign + Consent
- **KYC Service** — LEVEL_0/1/2 (financial services only)

### Cross-Cutting
- **Phone Binding** — 1 member → multi-phone
- **Device Binding** — 1 member → multi-device
- **Identity Resolution** — Duplicate detection (multi-signal)
- **MFA** — TOTP + SMS (risk-based)
- **Notification** — SMS/Email/Push (5 templates)
- **Reporting** — Success metrics dashboard
- **Migration** — Legacy → UUID (backward compat)
- **Cross-Tenant Point** — Transfer between tenants

---

## 💻 Code (GitHub: `likepoint-2.0` repo)

### Engines (12 ตัว)
| # | Engine | Tests | File |
|---|---|---|---|
| 1 | Wallet Rebinding | 8/8 | `apps/engine/wallet-rebind.js` |
| 2 | Identity Service | 10/10 | `apps/identity-service/member.js` |
| 3 | Phone Binding | 4/4 | `apps/engine/phone-binding.js` |
| 4 | Device Binding | 6/6 | `apps/engine/device-binding.js` |
| 5 | Identity Resolution | 9/9 | `apps/engine/identity-resolution.js` |
| 6 | MFA | 8/8 | `apps/engine/mfa.js` |
| 7 | Cross-Tenant Point | 6/6 | `apps/engine/cross-tenant-point.js` |
| 8 | Migration | 5/5 | `apps/engine/migration.js` |
| 9 | Reporting | 6/6 | `apps/engine/reporting.js` |
| 10 | KYC | (3/3) | `apps/engine/kyc.js` |
| 11 | Account Recovery | (2/2) | `apps/engine/recovery-flow.js` |
| 12 | Notification | (3/3) | `apps/engine/notification.js` |
| 13 | Tenant Service | 6/6 | `apps/engine/tenant-service.js` |

**Total: 76/76 tests = 100% PASS** 🎉

### HTTP APIs
- Identity Service: `apps/identity-service/server.js` (Express)
- Mock APIs: `apps/mock-api/server.js` (MS24 + Mini Like + PP7)

### SQL Migrations
- P0 Identity: `sql/migrations/2026-07-07-p0-identity-service.sql`
- P1 Phase A: `sql/migrations/2026-07-07-phase-a-qw1-qw3.sql`
- P2 Tenant: `sql/migrations/2026-07-07-p2-tenant-relationship.sql`

### Frontend (Phase A)
- Landing: `apps/index.html`
- Buy Point: `apps/mini-like/forms/buy-point.html`
- Admin Recovery: `apps/admin-console/pages/msp-recovery.html`

---

## 📊 Master Report (7 Tabs)

| Tab | Title | Audiences |
|---|---|---|
| 1 | Standards Reference (C+D) | Single |
| 2 | Audit (UAT) | All/Dev/PM/User |
| 3 | Production Incident | All/Dev/PM/User |
| 4 | Execution Roadmap | All/Dev/PM/User |
| 5 | Architecture Evolution | All/Dev/PM/User |
| 6 | Production Testing | All/Dev/PM/User |
| 7 | Admin Console + Requirements | All/Dev/PM/User |

**28 sub-panels total** — ดูผ่าน browser: `likepoint-2-master-report.html`

---

## 🎯 Phase A: Quick Win (Deployed)

**ไฟล์ที่ Deploy (5 ไฟล์):**
- `apps/index.html` (Landing page)
- `apps/mini-like/forms/buy-point.html` (REQ-1)
- `apps/admin-console/pages/msp-recovery.html` (QW-2)
- `sql/migrations/2026-07-07-phase-a-qw1-qw3.sql` (Schema)
- `docs/phase-a-implementation.md` (คู่มือ)

**Live URLs:**
- GitHub Pages: `https://rattapornkachakaewpkg-commits.github.io/likepoint-2.0/apps/`
- Tunnel: `https://ca49b450e4feba55-47-81-62-82.serveousercontent.com/apps/`

**Requirements:**
- ✅ REQ-1: ฟอร์มซื้อ Point (Risk-based)
- ✅ QW-1: Risk-based BCT Distribution
- ✅ QW-2: Admin Quick-Recovery Tool
- ✅ QW-3: BCT Hold Queue
- ⏸️ REQ-2: Finance Web Page (Top-up Approval)

---

## 🏆 RFC-001 Compliance: 11/11 (100%)

| Open Question | Status |
|---|---|
| #1 Merge Account | ✅ |
| #2 Multi-phone | ✅ |
| #3 Device Change | ✅ |
| #4 AI Duplicate | ✅ |
| #5 MFA | ✅ |
| #6 Cross-tenant Point | ✅ |
| #7 Migration | ✅ |
| #8 Reporting | ✅ |
| #9 KYC | ✅ |
| #10 Account Recovery | ✅ |
| #11 Notification | ✅ |

---

## 🚀 Phase B: Permanent Fix (Implementation Ready)

| Sprint | Status |
|---|---|
| S1: Mock API + Rebind Engine | ✅ 8/8 tests |
| S2: Webhook + Rebind Log UI | ⏸️ Ready |
| S3: E2E + Deploy | ⏸️ Ready |

---

## 🔐 Security & Access

| Resource | Value |
|---|---|
| GitHub | `rattapornkachakaewpkg-commits` |
| Repo | `likepoint-2.0` |
| SSH Key | `likepoint-2.0-deploy` (ED25519, Deploy key — repo เดียว) |
| ไม่ใช้ | `github_nattharinee_p5` (ของลูกหมี) |

---

## 📞 Contacts

- **PM:** แนน (HRD Manager | ADM CEO 2.0) — Telegram 5050203997
- **AI Co-Worker:** AliClaw — ผ่าน Telegram/Tools

---

## 🔄 Version History

| Date | Event |
|---|---|
| 7 ก.ค. 2569 06:00 | Phase 1 (Consultant): Spec + Analysis |
| 7 ก.ค. 2569 07:00 | Phase 2 (Implementer): Phase A (Quick Win) Deployed |
| 7 ก.ค. 2569 07:30 | RFC-001 Compliance 11/11 (100%) |
| 7 ก.ค. 2569 07:45 | LikePoint Platform Constitution v0.1 |
| 7 ก.ค. 2569 07:50 | Constitution v0.2 + Tenant Service + INDEX.md |

---

**🎯 เป้าหมาย:** Platform พร้อม Deploy Production (หลังจาก Dev review + UAT)
