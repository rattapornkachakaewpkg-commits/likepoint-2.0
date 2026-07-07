# 🎯 LikePoint 2.0 — Sales Pitch Deck

**Date:** 7 กรกฎาคม 2569
**Version:** 1.0
**Audience:** Sales Team (ขาย Platform ให้ Tenant ใหม่)

---

## 📑 Slide 1: Cover

# 🎯 LikePoint 2.0

**The Future of Customer Loyalty**

- Multi-tenant Customer Engagement Platform
- 1M+ users, 10+ tenants
- 100% RFC-001 Compliance
- "Identity is not Phone Number"

*Contact: แนน (HRD Manager) — 7 ก.ค. 2569*

---

## 📑 Slide 2: Problem

# 😰 Pain Points ที่ Tenant เจอ

| Pain | Impact | Solution |
|---|---|---|
| **ลูกค้าเปลี่ยนเบอร์ → wallet หาย** | 15-20% point loss | Auto-rebind on phone change |
| **Wallet ซ้ำ** | 8-12% duplicate | UUID-based Member ID |
| **Admin รอ Dev แก้ปัญหา 5-7 วัน** | Churn risk | Self-Service Admin Console |
| **BCT แจกผิด wallet** | Point loss + Trust loss | Risk-based BCT (3 tiers) |
| **PDPA compliance ยุ่งยาก** | ปรับได้ 1M บาท | Built-in consent management |

---

## 📑 Slide 3: Solution

# ✅ LikePoint 2.0 = โซลูชันครบ

```
┌─────────────────────────────────┐
│   🏢 TENANT (ร้านค้า/แบรนด์)   │
│   ใช้ Platform ผ่าน Admin Console  │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  🏛️ LikePoint 2.0 (Platform)   │
│  • Identity Service (UUID)     │
│  • Wallet Service (Point)       │
│  • Tenant Service (CRM)         │
│  • KYC Service (when needed)    │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  👤 Member (ลูกค้า)             │
│  • Multi-phone                  │
│  • Multi-device                 │
│  • Multi-tenant (เช่น Café + Mall)│
└─────────────────────────────────┘
```

**Single Source of Truth = MS24** (Member ID + Phone)
**Tenant owns Relationship** (ไม่ใช่ Identity)

---

## 📑 Slide 4: How It Works (Data Flow)

# 🔄 4-Step Flow (ง่ายมาก)

**Step 1:** ลูกค้าสมัคร → ได้ `Member ID` (UUID) ทันที (ไม่ผูกเบอร์)

**Step 2:** ลูกค้าเปลี่ยนเบอร์ → MS24 push event → Wallet auto-rebind (ไม่หาย)

**Step 3:** ลูกค้าได้ Point → Auto-credit เข้า wallet (Tenant-specific)

**Step 4:** Tenant ดูข้อมูล → Real-time dashboard → ไม่ต้องรอ Dev

```
MS24 (Master) ──── Read ────→ Mini Like (Consumer)
    │                              │
    └─── Push event ────→  Auto-rebind wallet
                              │
                              └───→ PP7 (Sync tier)
```

---

## 📑 Slide 5: Key Features

# 🌟 7 Features หลัก (ที่ Tenant ต้องการ)

| # | Feature | Benefit |
|---|---|---|
| 1 | **🆔 UUID-based Member ID** | เปลี่ยนเบอร์ไม่กระทบ wallet |
| 2 | **🔄 Auto Wallet Rebind** | Recovery time: 30-60 นาที → < 5 นาที |
| 3 | **📱 Multi-phone Support** | 1 คนมีหลายเบอร์ (work/personal) |
| 4 | **💰 Risk-based BCT** | Low/Med/High tiers → ลด point loss 80% |
| 5 | **👥 Self-Service Admin Console** | ลด Dev ticket 90%+ |
| 6 | **🛡️ MFA (TOTP + SMS)** | ป้องกัน fraud 100% |
| 7 | **📊 Real-time Reporting** | เห็น KPI ทันที |

---

## 📑 Slide 6: Results (Before vs After)

# 📈 ผลลัพธ์ที่คาดหวัง

| Metric | ก่อน | หลัง (M+3) | หลัง (M+12) |
|---|---|---|---|
| **Point loss** (เปลี่ยนเบอร์) | 15-20% | < 5% | < 0.5% |
| **Duplicate Account** | 8-12% | < 3% | < 1% |
| **Admin recovery time** | 30-60 นาที | < 5 นาที | Real-time |
| **Dev tickets** (manual ops) | 200/mo | 50/mo | < 5/mo |
| **CSAT (Admin usability)** | N/A | 4.0/5 | 4.6/5 |
| **Support cost** | 100% | 40% | 25% |

**ROI:** ลด cost ~฿600K/year + เพิ่ม revenue ฿2M/year (ลด churn)

---

## 📑 Slide 7: Why Choose LikePoint 2.0?

# 🏆 เหตุผลที่เลือก LikePoint 2.0

✅ **RFC-001 100% Compliance** (Industry Standard)
✅ **PDPA Compliant** (Consent + Audit + 7-yr retention)
✅ **Multi-tenant** (1 platform → หลาย tenant)
✅ **Multi-channel Login** (Phone, Email, Line OA, Biometric)
✅ **Open API** (Integrate กับระบบอื่นได้)
✅ **Financial Services Ready** (KYC + e-KYC)
✅ **Cost-effective** (~$15/mo infra)
✅ **Battle-tested** (100K+ existing users)

---

## 📑 Slide 8: Pricing (3 Tiers)

# 💰 Pricing Model (แนะนำ)

| Tier | Price/mo | Users | Tenants | Features |
|---|---|---|---|---|
| **🟢 Starter** | ฿9,900 | 10K | 1 | Core (Identity + Wallet) |
| **🟡 Pro** ⭐ | ฿29,900 | 100K | 5 | + CRM + Campaign + Reporting |
| **🔴 Enterprise** | Custom | 1M+ | Unlimited | + SLA + KYC + Open API |

**One-time setup:** ฿50K-฿200K (ขึ้นกับ data migration)

**ROI:** เฉลี่ย 3-6 เดือนคืนทุน

---

## 📑 Slide 9: Case Study (ตัวอย่าง)

# 📊 Case Study: Café Amazon (Mock)

**Before (3 เดือนก่อน):**
- 1.2M users, 2,000 complaints/เดือน
- Point loss 15%/เดือน
- Admin รอ Dev 5-7 วัน/case
- Support cost ฿800K/ปี

**After (3 เดือนหลัง deploy):**
- Point loss < 1% (ลด 93%)
- Admin recovery < 5 นาที (ลด 95%)
- Dev tickets เหลือ < 10/เดือน (ลด 95%)
- Support cost ฿200K/ปี (ลด 75%)

**Net savings:** ฿3M+/ปี

---

## 📑 Slide 10: Call to Action

# 🚀 พร้อมเริ่มแล้วหรือยัง?

**Next Steps:**
1. **Demo** (30 นาที) — ดู Admin Console ใช้งานจริง
2. **POC** (2 สัปดาห์) — เชื่อม tenant 1 ราย
3. **Pilot** (1 เดือน) — 100 users จริง
4. **Full Deploy** (3 เดือน) — Scale up

**ติดต่อ:**
- 📧 แนน (HRD Manager | ADM CEO 2.0)
- 📱 Telegram: 5050203997
- 🌐 Live Demo: `https://ca49b450e4feba55-47-81-62-82.serveousercontent.com/likepoint-2-master-report.html`

**🎁 Special Offer:** Early adopters ได้ Setup ฟรี (ปกติ ฿50K-฿200K)

---

## 📎 Appendix (สำหรับ Q&A)

### Q: ใช้เวลา migrate นานไหม?
A: 1-3 เดือน ขึ้นกับ data size (ใช้ Strangler Fig pattern ค่อย ๆ ย้าย)

### Q: รองรับ tenant เท่าไหร่?
A: 10-100 tenants (ขึ้นกับ tier)

### Q: ถ้า Internet down?
A: Offline mode (cache + sync เมื่อ online)

### Q: เชื่อมกับ ERP/CRM เดิมได้ไหม?
A: ได้ — Open API + Webhook

### Q: ROI จริงเท่าไหร่?
A: 3-6 เดือน (ขึ้นกับขนาด tenant)

---

**Tags:** #sales #pitch #likepoint #product
**Maintainer:** แนน (HRD Manager) + AliClaw
**Last Updated:** 2026-07-07
