# ❓ FAQ — LikePoint 2.0

**For:** End User, Admin, PM, Developer
**Date:** 7 กรกฎาคม 2569

---

## 👤 User (ลูกค้าทั่วไป)

### Q: LikePoint 2.0 คืออะไร?
A: แอปสะสมแต้ม + รับส่วนลดจากร้านค้าที่เข้าร่วม (Café Amazon, The Mall, ฯลฯ)

### Q: สมัครฟรีไหม?
A: ฟรี! (Tenant บางรายอาจมี tier ที่ต้องจ่าย)

### Q: เปลี่ยนเบอร์โทรแล้ว Point หายไหม?
A: **ไม่หายแน่นอน** ✅ (UUID-based Member ID — เบอร์เป็นแค่ Login)

### Q: ใช้เวลาเปลี่ยนเบอร์นานไหม?
A: < 3 นาที (ไม่ต้องติดต่อ Admin)

### Q: ลืมรหัสผ่าน?
A: Login → "ลืมรหัสผ่าน" → รับ OTP ทาง SMS

### Q: สมัครได้กี่เบอร์ต่อคน?
A: 1 คนมีได้สูงสุด 5 เบอร์ (work/personal/family)

### Q: ลบบัญชีได้ไหม?
A: ได้ — Settings → "ลบบัญชี" (Point จะหาย แนะนำใช้ให้หมดก่อน)

### Q: โอน Point ให้เพื่อนได้ไหม?
A: ได้ (สูงสุด 10,000 P/วัน) — Profile → "โอน Point"

### Q: ทำไมโอน Point ไม่ได้?
A: ตรวจสอบ: (1) Balance เพียงพอ? (2) 2FA เปิดใช้งาน? (3) ไม่เกิน 10K/วัน?

### Q: Trust Score คืออะไร?
A: คะแนนความน่าเชื่อถือ (0-100) — ยิ่งสูงยิ่งปลอดภัย

### Q: โดนแจ้งเตือน "New device login" แต่ไม่ได้ login?
A: กด "ไม่ใช่ฉัน" ทันที — เราจะ lock account ให้

---

## 👨‍💼 Admin (เจ้าหน้าที่)

### Q: ลูกค้าบ่น "เปลี่ยนเบอร์แล้ว Point หาย" ทำยังไง?
A: ใช้ **MSP Recovery Tool** (Admin Console → Recovery)
   1. Search phone เก่า → ค้นหา Person 360
   2. ระบบแสดง wallet mismatch อัตโนมัติ
   3. 2FA → Execute (ใช้เวลา < 5 นาที)

### Q: จะรู้ได้ไงว่า wallet ไหนซ้ำ?
A: Admin Console → Identity Queue (ระบบ auto-detect + แสดง confidence)

### Q: ใคร approve auto-merge ได้บ้าง?
A: 3 roles: Super Admin (ทุกอย่าง), Tenant Admin (tenant ตัวเอง), Support Agent (ต้อง approval)

### Q: Audit Log เก็บกี่ปี?
A: 7 ปี (ตาม PDPA)

### Q: จะ export audit log ได้ไหม?
A: ได้ — Audit Log → Export → CSV

### Q: โอน Point ให้ลูกค้า ต้องใส่เหตุผลไหม?
A: ต้อง (required) — เพื่อ PDPA compliance

### Q: ระบบช้า / ค้าง ทำยังไง?
A: ดู Reporting Dashboard → ถ้า > 5s response time → alert Dev

---

## 💼 PM (ผู้จัดการโครงการ)

### Q: Phase ไหนเสร็จแล้ว?
A: P0-P2 Done (100%), P3 In Progress (Phase A Deployed), P4-P5 ปี 2027

### Q: Budget Q3-Q4 เท่าไหร่?
A: ~฿800K (2 Dev senior + 1 PM + infra)

### Q: ROI จริงเท่าไหร่?
A: 3-6 เดือน (ขึ้นกับขนาด tenant) — ลด cost ฿600K/ปี + เพิ่ม revenue ฿2M/ปี

### Q: Top risks คือ?
A: (1) Migration (ใช้ Strangler Fig) (2) Trust Score Cold Start (3) PDPA compliance

### Q: ใครเป็นคน approve Production deploy?
A: Super Admin (ระบบ CI/CD + manual approval)

### Q: ต้อง Present ให้ฝ่ายบริหาร — ใช้เอกสารอะไร?
A: [EXECUTIVE-SUMMARY.md](../EXECUTIVE-SUMMARY.md) (1 หน้า) — อ่าน 5 นาที

### Q: จะขายให้ Tenant ใหม่ — ใช้ Deck ไหน?
A: [PITCH-DECK.md](../sales/PITCH-DECK.md) (10 slides)

### Q: Dev ต้องอ่านอะไร?
A: [TASK-BOARD.md](../TASK-BOARD.md) (consolidated)

---

## 👨‍💻 Developer

### Q: เริ่มต้นที่ไหน?
A: อ่าน [INDEX.md](../../INDEX.md) → เลือก Phase

### Q: โครงสร้าง Code เป็นยังไง?
A: `apps/identity-service/` + `apps/engine/` + `apps/admin-console/`

### Q: มี Tests ไหม?
A: มีครบ — 82 tests, 100% pass

### Q: Setup local dev ยังไง?
A: `cd apps/identity-service && npm install && node server.js` (port 3002)

### Q: Test Engine ยังไง?
A: `node apps/engine/wallet-rebind.test.js`

### Q: API Endpoints?
A: ดูใน `apps/identity-service/server.js` (Express) — 10 endpoints

### Q: SQL Migrations?
A: `sql/migrations/2026-07-07-*.sql` (3 files)

### Q: Deploy ยังไง?
A: Git push → Vercel auto + แนน deploy Firebase manual

### Q: Tests fail?
A: ดู test output → fix → rerun

### Q: เพิ่ม Feature ใหม่ ทำยังไง?
A: สร้าง Engine ใหม่ใน `apps/engine/` + test → push → merge PR

---

## 🛡️ Security / PDPA

### Q: ข้อมูลลูกค้าเก็บที่ไหน?
A: PostgreSQL (Production) + Audit log 7 ปี

### Q: เบอร์โทรเก็บแบบ plain text ไหม?
A: ไม่ — เก็บเป็น SHA256 hash + แสดง mask (08x-xxx-xxxx)

### Q: ใครเข้าถึงข้อมูลได้?
A: 3 roles: Super Admin / Tenant Admin / Support Agent (RBAC)

### Q: Audit log เก็บอะไรบ้าง?
A: ทุก action + admin user + timestamp + reason + IP + user agent

### Q: ลูกค้าขอ "สิทธิ์ในการลบข้อมูล" (PDPA Right to Erasure)?
A: ได้ — Settings → "ลบบัญชี" (soft delete 7 วัน)

---

## 📞 ติดต่อ

| ปัญหา | ช่องทาง |
|---|---|
| **Bug / Crash** | GitHub Issues → label `bug` |
| **Feature Request** | GitHub Issues → label `enhancement` |
| **PDPA / Privacy** | privacy@likepoint.com |
| **Sales / Demo** | แนน (Telegram 5050203997) |
| **Dev Question** | AliClaw (Telegram) |
| **Emergency** | +66-XX-XXX-XXXX (24/7) |

---

**Last Updated:** 2026-07-07
**Maintainer:** AliClaw + แนน
