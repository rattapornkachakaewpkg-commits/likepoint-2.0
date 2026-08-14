# Phase F: PF-23 Role Approval Engine

**Status:** ✅ Implemented (19/19 tests pass)
**Date:** 2026-08-14
**Resolves:** LP-FEED-2026-08-14 issues #10 + #11
**From feedback:** วิชัย(ขวัญ) @wichaiwon CPDG-APP

---

## 🎯 Purpose

Implements role/approval workflow for LP2.0 admin console:
- Invite user → role with mandatory approval gate
- Superadmin-only voting (general admin role CANNOT approve)
- Source console lock (only `merchant_admin_console` can request)
- Full audit trail for governance

---

## 🐛 Resolves Feedback

### #10: Invite ไม่สร้างกลุ่ม approve (BUG)
**Before:**
```
inviteUser() → INSERT invitation → NOTIFY room (legacy)
[NO APPROVAL GROUP CREATED]  ← BUG
```

**After (PF-23):**
```
inviteEngine.requestInvite()
  ├─ INSERT role_invitations (status=pending)
  ├─ NOTIFY ห้องรับใช้/pkg_support (legacy, preserved)
  ├─ PUBLISH 'role.invite.requested' event  ← NEW
  └─ AUDIT 'invite.created'

eventBus.subscribe('role.invite.requested', approvalEngine.createFromInvite)
  ├─ INSERT role_approval_groups (status=open)
  ├─ NOTIFY superadmin (NOT general admin!)  ← NEW
  ├─ AUDIT 'group.created'
  └─ PUBLISH 'role.approval.opened' event
```

### #11: Spec — Approval scope
- ✅ Source: `merchant_admin_console` only (RLS + app-layer validation)
- ✅ Approver audience: `superadmin` role only
- ✅ General admin role CANNOT vote (RLS + app-layer check)

---

## 🏗️ Architecture

```
┌─────────────────────────┐
│  merchant_admin_console │
│  (invite UI)            │
└────────────┬────────────┘
             │ requestInvite()
             ▼
┌─────────────────────────┐
│  RoleInviteEngine       │ ── PUBLISH ──▶ 'role.invite.requested'
│  - source_console check │                       │
│  - role_code validation │                       ▼
│  - audit log            │       ┌──────────────────────────────┐
└─────────────────────────┘       │  ApprovalGroupEngine         │
                                  │  - createFromInvite()        │
                                  │  - castVote()                │
                                  │  - RLS: superadmin only      │
                                  └──────────────┬───────────────┘
                                                 │
                            ┌────────────────────┼────────────────────┐
                            ▼                    ▼                    ▼
                  NOTIFY superadmin    PUBLISH 'role.invite.    PUBLISH 'role.invite.
                  (ห้องรับใช้ /         approved' OR             rejected'
                   pkg_support)         'role.invite.rejected'    
                            │                    │                    │
                            └────────────────────┴────────────────────┘
                                                 │
                                                 ▼
                                       role_assignment_audit
                                       (governance trail)
```

---

## 📦 Files Delivered

| File | Size | Purpose |
|------|------|---------|
| `apps/engine/role-approval-engine.js` | 14.6 KB | RoleInviteEngine + ApprovalGroupEngine |
| `apps/engine/role-approval-engine.test.js` | 19.0 KB | 19 unit tests (100% pass) |
| `apps/admin-console/pages/role-approval.html` | 13.7 KB | Interactive superadmin console |
| `apps/admin-console/engines/role-approval-engine.js` | (copy) | For browser-based demo |
| `sql/migrations/2026-08-14-phase-f-pf23-role-approval.sql` | 10.6 KB | 4 tables + 2 views + RLS + helper fn |
| `docs/phase-f-pf23-role-approval.md` | (this file) | Spec + architecture |

---

## 🧪 Test Coverage (19/19 pass)

| Category | Tests | Pass |
|----------|-------|------|
| A. RoleInviteEngine flow | 6 | ✅ |
| B. ApprovalGroupEngine event sub | 3 | ✅ |
| C. Spec #11 — superadmin-only | 3 | ✅ |
| D. Voting + group closure | 3 | ✅ |
| E. Vote summary | 1 | ✅ |
| F. Idempotency + errors | 3 | ✅ |
| **Total** | **19** | **✅** |

### Key Test Cases

**A1:** requestInvite → pending status + event published
**A2:** source_console ≠ merchant_admin_console → throws (spec lock)
**B2:** End-to-end: inviteEngine.requestInvite() → approvalEngine auto-creates group (fix #10)
**C1:** All non-superadmin roles → vote rejected
**D1:** N approvals reach min → group closes + `role.invite.approved` published
**D2:** Any reject → group closes with `role.invite.rejected`
**F3:** Phone carried in event payload for audit

---

## 🗄️ Database Schema

### Tables (4)
- `roles` — role catalog with permission flags
- `role_invitations` — pending/approved/rejected/cancelled invites
- `role_approval_groups` — one per pending invite, status lifecycle
- `role_approval_votes` — superadmin vote records (1 per approver per group)
- `role_assignment_audit` — full governance trail

### Views (2)
- `v_role_invitations_full` — joined UI view
- `v_pending_approvals_for_superadmin` — superadmin dashboard query

### RLS Policies (3)
1. `approve_role_invite_superadmin_only` — only superadmin role can vote
2. `invite_via_merchant_console_only` — invite must originate from `merchant_admin_console`
3. `view_role_invites_scoped` — superadmin sees all, others see own tenant only

### Helper Function (1)
- `close_approval_group_if_done(p_group_id)` — auto-close on threshold reached

---

## 🎨 Admin Console Features

**Page:** `/apps/admin-console/pages/role-approval.html`

- 📨 **Invite Form** — full validation, locked source_console
- ⏳ **Pending Approvals** — live list of open groups for superadmin
- 🗳️ **Approve/Reject Buttons** — single-click voting
- 📊 **Stats** — open/approved/rejected counts
- 📋 **Audit Log** — live event stream (last 15 entries)
- 🔄 **Auto-refresh** every 3 seconds
- 🔒 **Spec rules** displayed at top

---

## 🔌 Event Topics

| Topic | Publisher | Subscribers | Payload |
|-------|-----------|-------------|---------|
| `role.invite.requested` | RoleInviteEngine | ApprovalGroupEngine | invitation details |
| `role.approval.opened` | ApprovalGroupEngine | UI dashboards | group_id, role, required_role |
| `role.invite.approved` | ApprovalGroupEngine | role activation service | invitation_id, decision, actor |
| `role.invite.rejected` | ApprovalGroupEngine | notification service | invitation_id, decision, actor |

---

## 🚀 Deploy

- **Branch:** `feature/phase-f-pf23-role-approval`
- **SSH Key:** `likepoint-2.0-deploy` (repo-only)
- **Target:** merge → main → GitHub Pages auto-deploy
- **Live URL (after deploy):** https://rattapornkachakaewpkg-commits.github.io/likepoint-2.0/apps/admin-console/pages/role-approval.html

---

## 📊 Cumulative Status (LP 2.0 — 23 cycles)

| Cycle | Phase | Feature | Tests | Status |
|-------|-------|---------|-------|--------|
| 1-22 | A-E | (see prior docs) | 479+ | ✅ |
| **23** | **F** | **Role/Approval Engine** | **19** | **✅** |
| **Total** | | | **498** | **100%** |

---

## 🎓 Lessons Learned

1. **Approval workflow ≠ notification** — legacy systems often conflate "notify" with "approve". PF-23 separates them via EventBus.
2. **Spec compliance via RLS + app-layer** — defense in depth: same rule enforced at SQL level AND in JS engine (so violations fail early even without DB).
3. **Idempotent subscribers** — `subscribe()` is idempotent (subscribed once), preventing double-handling on hot-reload.
4. **Reject > Approve priority** — any single reject immediately closes the group. Avoids waiting for full approval when consensus is "no".
5. **Phone in event payload** — for SMS verification flow downstream (compliance/audit).
6. **Source console lockdown** — prevents invite from web forms, CLI, etc. Only the official console path can request.

---

## 👥 Roles Definition

| role_code | can_approve_role | can_invite_role | scope |
|-----------|------------------|-----------------|-------|
| `superadmin` | ✅ true | ✅ true | system |
| `admin` | ❌ false | ❌ false | tenant |
| `merchant_admin` | ❌ false | ✅ true | merchant |
| `viewer` | ❌ false | ❌ false | tenant |

---

## 🔗 Related

- LP-FEED-2026-08-14 (memory file): `memory/2026-08-14-likepoint-feedback-khw.md` + `...-v2.md`
- Event Bus (PF-4): `apps/engine/event-bus.js`
- Audit Engine (PF-5): `apps/engine/audit-engine.js`

---

## ✅ Sign-off

- [x] All 19 tests pass
- [x] Spec #11 enforced (superadmin-only voting + MAC-only invite)
- [x] Bug #10 fixed (approval group auto-created via event)
- [x] Audit trail complete
- [x] Admin console interactive
- [x] Doc complete
- [ ] Dev review (when วิชัย(ขวัญ) online)
- [ ] Production deploy (after review)