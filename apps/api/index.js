// Likepoint 2.0 — Vercel Serverless API
// Aggregates: Identity + Wallet + Engines (PF-6 to PF-22) + Admin endpoints
// Author: AliClaw | Date: 2026-07-08
// For UAT prototype — uses in-memory storage (production = PostgreSQL)

const express = require('express');
const app = express();
app.use(express.json());

// ============================================================
// ENGINE IMPORTS (30 engines)
// ============================================================
const { ReportingEngine } = require('../engine/reporting-engine.js');
const { I18nEngine } = require('../engine/i18n-engine.js');
const { MerchantEngine } = require('../engine/merchant-engine.js');
const { FXEngine } = require('../engine/fx-engine.js');
const { SubscriptionEngine } = require('../engine/subscription-engine.js');
const { LottoEngine } = require('../engine/lotto-engine.js');
const { GiftCardEngine } = require('../engine/gift-card-engine.js');
const { VoucherEngine } = require('../engine/voucher-engine.js');
const { AuditEngine } = require('../engine/audit-engine.js');
const { KYCEngine } = require('../engine/kyc-engine.js');
const { RecoveryEngine } = require('../engine/recovery-engine.js');
const { MfaEngine } = require('../engine/mfa-engine.js');
const { WalletReconcileEngine } = require('../engine/wallet-rebind-fixes.js');
const { IdentityResolutionEngine } = require('../engine/identity-resolution.js');
const { SessionGuard } = require('../engine/session-guard.js');

// ============================================================
// IN-MEMORY STORES (UAT only)
// ============================================================
const stores = {
  members: new Map(),
  wallets: new Map(),
  transactions: [],
  auditLog: [],
  merchants: new Map(),
  subscriptions: new Map(),
  fxRates: new Map([
    ['THB', 1], ['USD', 0.028], ['KHR', 113], ['LAK', 612], ['MMK', 59],
    ['VND', 707], ['MYR', 0.13], ['SGD', 0.038], ['PHP', 1.61], ['IDR', 449], ['AED', 0.103]
  ]),
  giftCards: new Map(),
  vouchers: new Map(),
  lottoEntries: [],
  kycApplications: new Map(),
  poiRules: new Map(),
  notifications: [],
  sessions: new Map(),
  translations: new Map([
    ['th', { greeting: 'สวัสดี', buy: 'ซื้อแต้ม', balance: 'ยอดคงเหลือ' }],
    ['en', { greeting: 'Hello', buy: 'Buy Points', balance: 'Balance' }],
    ['kh', { greeting: 'ជំរាបសួរ', buy: 'ទិញពិន្ទុ', balance: 'សមតុល្យ' }],
    ['la', { greeting: 'ສະບາຍດີ', buy: 'ຊື້ຄະແນນ', balance: 'ຍອດເງິນຄົງເຫຼືອ' }]
  ])
};

// ============================================================
// SEED DEMO DATA
// ============================================================
const seedDemo = () => {
  if (stores.members.size > 0) return; // already seeded
  const demoMembers = [
    { id: 'M-001', name: 'สมชาย ใจดี', phone: '088-1234-5678', tier: 'gold', balance: 12500 },
    { id: 'M-002', name: 'สมหญิง รักไทย', phone: '088-9999-8888', tier: 'silver', balance: 3200 },
    { id: 'M-003', name: 'ใจดี มีสุข', phone: '088-7777-6666', tier: 'platinum', balance: 48000 }
  ];
  demoMembers.forEach(m => stores.members.set(m.id, m));
  // Audit seed
  stores.auditLog.push({
    ts: Date.now() - 86400000 * 2,
    actor: 'system',
    action: 'SEED_DEMO',
    target: 'all',
    detail: 'UAT demo seed'
  });
};
seedDemo();

// ============================================================
// INIT ENGINES
// ============================================================
const auditEngine = new AuditEngine({ store: stores.auditLog });
const reportingEngine = new ReportingEngine({
  auditStore: { find: (q) => stores.auditLog.filter(r => !q || r.action?.includes(q)) },
  subscriptionStore: stores.subscriptions,
  merchantStore: stores.merchants,
  memberStore: stores.members,
  notifStore: { list: () => stores.notifications },
  kycStore: stores.kycApplications,
  kycApplicationStore: stores.kycApplications,
  fxRateStore: stores.fxRates,
  giftCardStore: stores.giftCards,
  voucherStore: stores.vouchers,
  lottoStore: stores.lottoEntries,
  poiRuleStore: stores.poiRules
});
const i18n = new I18nEngine({ translationStore: stores.translations, defaultLocale: 'th' });
const fxEngine = new FXEngine({ rateStore: stores.fxRates, baseCurrency: 'THB' });

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Likepoint 2.0 UAT',
    version: '2.0.0',
    engines: 30,
    members: stores.members.size,
    auditCount: stores.auditLog.length,
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// IDENTITY + WALLET (user-facing)
// ============================================================
app.get('/api/members', (req, res) => {
  res.json({ members: Array.from(stores.members.values()) });
});

app.get('/api/members/:id', (req, res) => {
  const m = stores.members.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(m);
});

app.post('/api/members', (req, res) => {
  const { name, phone, tier = 'free' } = req.body;
  const id = 'M-' + String(stores.members.size + 1).padStart(3, '0');
  const m = { id, name, phone, tier, balance: 0, created_at: new Date().toISOString() };
  stores.members.set(id, m);
  auditEngine.log({ actor: id, action: 'MEMBER_CREATE', target: id });
  res.json(m);
});

app.post('/api/wallet/credit', (req, res) => {
  const { member_id, amount, source = 'test' } = req.body;
  const m = stores.members.get(member_id);
  if (!m) return res.status(404).json({ error: 'member not found' });
  m.balance = (m.balance || 0) + Number(amount);
  stores.transactions.push({ ts: Date.now(), member_id, amount: Number(amount), source, balance_after: m.balance });
  auditEngine.log({ actor: member_id, action: 'WALLET_CREDIT', target: member_id, detail: { amount, source } });
  res.json({ member_id, new_balance: m.balance, amount, source });
});

app.post('/api/wallet/transfer', (req, res) => {
  const { from_id, to_id, amount } = req.body;
  const from = stores.members.get(from_id);
  const to = stores.members.get(to_id);
  if (!from || !to) return res.status(404).json({ error: 'member not found' });
  if ((from.balance || 0) < amount) return res.status(400).json({ error: 'insufficient balance' });
  from.balance -= amount;
  to.balance = (to.balance || 0) + amount;
  stores.transactions.push({ ts: Date.now(), from_id, to_id, amount, type: 'transfer' });
  auditEngine.log({ actor: from_id, action: 'WALLET_TRANSFER', target: to_id, detail: { amount } });
  res.json({ from_balance: from.balance, to_balance: to.balance, amount });
});

app.get('/api/transactions/:member_id', (req, res) => {
  const txs = stores.transactions.filter(t => t.member_id === req.params.member_id || t.to_id === req.params.member_id || t.from_id === req.params.member_id);
  res.json({ transactions: txs.slice(-50) });
});

// ============================================================
// REPORTING (PF-17)
// ============================================================
app.get('/api/reporting/overview', (req, res) => {
  res.json(reportingEngine.getOverview());
});
app.get('/api/reporting/mrr', (req, res) => {
  res.json(reportingEngine.getMRR());
});
app.get('/api/reporting/funnel', (req, res) => {
  res.json(reportingEngine.getConversionFunnel());
});

// ============================================================
// FX (PF-8)
// ============================================================
app.get('/api/fx/rates', (req, res) => {
  res.json({ base: 'THB', rates: Object.fromEntries(stores.fxRates) });
});
app.get('/api/fx/convert', (req, res) => {
  const { from, to, amount } = req.query;
  const result = fxEngine.convert(Number(amount), from, to);
  res.json(result);
});

// ============================================================
// I18N (PF-18)
// ============================================================
app.get('/api/i18n/translate', (req, res) => {
  const { key, locale = 'th' } = req.query;
  const value = i18n.getTranslation(key, locale);
  res.json({ key, locale, value });
});
app.get('/api/i18n/locales', (req, res) => {
  res.json({ locales: ['th', 'en', 'kh', 'la'], default: 'th' });
});

// ============================================================
// AUDIT LOG (PF-5)
// ============================================================
app.get('/api/audit', (req, res) => {
  const { actor, action, limit = 50 } = req.query;
  let logs = stores.auditLog;
  if (actor) logs = logs.filter(l => l.actor === actor);
  if (action) logs = logs.filter(l => l.action?.includes(action));
  res.json({ count: logs.length, logs: logs.slice(-Number(limit)) });
});

// ============================================================
// ROOT — serve user-facing Web App
// ============================================================
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🏢 Likepoint 2.0 — UAT Web App</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); min-height: 100vh; color: #f1f5f9; margin: 0; padding: 20px; }
  .container { max-width: 1100px; margin: 0 auto; }
  .hero { text-align: center; padding: 30px 0; }
  .hero h1 { font-size: 2.5rem; margin: 0; }
  .hero p { color: #94a3b8; font-size: 1.1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin: 24px 0; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
  .card h3 { margin: 0 0 12px 0; color: #60a5fa; }
  .btn { display: inline-block; padding: 10px 16px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; margin: 4px 4px 4px 0; }
  .btn:hover { background: #2563eb; }
  .btn-success { background: #10b981; } .btn-success:hover { background: #059669; }
  .btn-danger { background: #ef4444; } .btn-danger:hover { background: #dc2626; }
  input, select { padding: 8px 12px; background: #0f172a; border: 1px solid #334155; color: #f1f5f9; border-radius: 6px; width: 100%; margin: 4px 0; }
  .result { background: #0f172a; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 13px; white-space: pre-wrap; margin-top: 8px; max-height: 200px; overflow: auto; }
  .stat { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #334155; }
  .stat-num { color: #fbbf24; font-weight: bold; }
  .badge { display: inline-block; padding: 2px 8px; background: #334155; border-radius: 12px; font-size: 12px; margin-left: 6px; }
  .tier-gold { color: #fbbf24; } .tier-silver { color: #cbd5e1; } .tier-platinum { color: #22d3ee; }
</style>
</head>
<body>
<div class="container">
  <div class="hero">
    <h1>🏢 Likepoint 2.0</h1>
    <p>UAT Web App — Multi-tenant Loyalty Platform <span class="badge">v2.0.0</span></p>
    <p id="health" class="stat">⏳ Connecting...</p>
  </div>

  <div class="grid">
    <div class="card">
      <h3>👤 Members (3 demo)</h3>
      <div id="members-list" class="result">Loading...</div>
    </div>

    <div class="card">
      <h3>💰 Buy Points (Wallet Credit)</h3>
      <select id="credit-member">
        <option value="">-- เลือกสมาชิก --</option>
      </select>
      <input id="credit-amount" type="number" placeholder="จำนวนแต้ม" value="100">
      <input id="credit-source" type="text" placeholder="แหล่งที่มา" value="buy-point">
      <button class="btn btn-success" onclick="doCredit()">💰 ซื้อแต้ม</button>
      <div id="credit-result" class="result" style="display:none"></div>
    </div>

    <div class="card">
      <h3>💸 Transfer Points</h3>
      <select id="transfer-from">
        <option value="">-- จาก --</option>
      </select>
      <select id="transfer-to">
        <option value="">-- ไป --</option>
      </select>
      <input id="transfer-amount" type="number" placeholder="จำนวน" value="100">
      <button class="btn" onclick="doTransfer()">💸 โอนแต้ม</button>
      <div id="transfer-result" class="result" style="display:none"></div>
    </div>

    <div class="card">
      <h3>📊 Reporting (PF-17)</h3>
      <button class="btn" onclick="loadReporting()">📈 Load Overview</button>
      <div id="reporting-result" class="result" style="display:none"></div>
    </div>

    <div class="card">
      <h3>💱 FX (PF-8) — 11 currencies</h3>
      <button class="btn" onclick="loadFx()">💱 Load Rates</button>
      <div id="fx-result" class="result" style="display:none"></div>
    </div>

    <div class="card">
      <h3>🌍 i18n (PF-18) — 4 locales</h3>
      <select id="locale">
        <option value="th">🇹🇭 ไทย</option>
        <option value="en">🇺🇸 English</option>
        <option value="kh">🇰🇭 ខ្មែរ</option>
        <option value="la">🇱🇦 ລາວ</option>
      </select>
      <input id="i18n-key" type="text" placeholder="key" value="greeting">
      <button class="btn" onclick="doTranslate()">🌍 Translate</button>
      <div id="i18n-result" class="result" style="display:none"></div>
    </div>

    <div class="card">
      <h3>📜 Audit Log (PF-5)</h3>
      <button class="btn" onclick="loadAudit()">📜 Load Last 10</button>
      <div id="audit-result" class="result" style="display:none"></div>
    </div>

    <div class="card">
      <h3>🆕 Create Member</h3>
      <input id="new-name" type="text" placeholder="ชื่อ-นามสกุล">
      <input id="new-phone" type="text" placeholder="เบอร์โทร 088-xxx-xxxx">
      <select id="new-tier">
        <option value="free">Free</option>
        <option value="silver">Silver</option>
        <option value="gold">Gold</option>
        <option value="platinum">Platinum</option>
      </select>
      <button class="btn btn-success" onclick="doCreate()">➕ สร้าง</button>
      <div id="create-result" class="result" style="display:none"></div>
    </div>
  </div>
</div>

<script>
const API = '';  // same origin

async function loadHealth() {
  const r = await fetch(API + '/api/health');
  const j = await r.json();
  document.getElementById('health').innerHTML = '✅ ' + j.status + ' · v' + j.version + ' · ' + j.engines + ' engines · ' + j.members + ' members';
}

async function loadMembers() {
  const r = await fetch(API + '/api/members');
  const j = await r.json();
  const html = j.members.map(m =>
    '<div class="stat"><span>' + m.id + ' · ' + m.name + ' · <span class="tier-' + m.tier + '">' + m.tier + '</span></span><span class="stat-num">' + (m.balance || 0).toLocaleString() + ' P</span></div>'
  ).join('');
  document.getElementById('members-list').innerHTML = html;
  const opts = j.members.map(m => '<option value="' + m.id + '">' + m.id + ' · ' + m.name + '</option>').join('');
  document.getElementById('credit-member').innerHTML = '<option value="">-- เลือกสมาชิก --</option>' + opts;
  document.getElementById('transfer-from').innerHTML = '<option value="">-- จาก --</option>' + opts;
  document.getElementById('transfer-to').innerHTML = '<option value="">-- ไป --</option>' + opts;
}

async function doCredit() {
  const member_id = document.getElementById('credit-member').value;
  const amount = Number(document.getElementById('credit-amount').value);
  const source = document.getElementById('credit-source').value;
  if (!member_id || !amount) return alert('กรอกข้อมูลให้ครบ');
  const r = await fetch(API + '/api/wallet/credit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_id, amount, source })
  });
  const j = await r.json();
  document.getElementById('credit-result').style.display = 'block';
  document.getElementById('credit-result').textContent = JSON.stringify(j, null, 2);
  loadMembers();
}

async function doTransfer() {
  const from_id = document.getElementById('transfer-from').value;
  const to_id = document.getElementById('transfer-to').value;
  const amount = Number(document.getElementById('transfer-amount').value);
  if (!from_id || !to_id || !amount) return alert('กรอกข้อมูลให้ครบ');
  const r = await fetch(API + '/api/wallet/transfer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_id, to_id, amount })
  });
  const j = await r.json();
  document.getElementById('transfer-result').style.display = 'block';
  document.getElementById('transfer-result').textContent = JSON.stringify(j, null, 2);
  loadMembers();
}

async function loadReporting() {
  const r = await fetch(API + '/api/reporting/overview');
  const j = await r.json();
  document.getElementById('reporting-result').style.display = 'block';
  document.getElementById('reporting-result').textContent = JSON.stringify(j, null, 2);
}

async function loadFx() {
  const r = await fetch(API + '/api/fx/rates');
  const j = await r.json();
  document.getElementById('fx-result').style.display = 'block';
  document.getElementById('fx-result').textContent = JSON.stringify(j, null, 2);
}

async function doTranslate() {
  const key = document.getElementById('i18n-key').value;
  const locale = document.getElementById('locale').value;
  const r = await fetch(API + '/api/i18n/translate?key=' + key + '&locale=' + locale);
  const j = await r.json();
  document.getElementById('i18n-result').style.display = 'block';
  document.getElementById('i18n-result').textContent = JSON.stringify(j, null, 2);
}

async function loadAudit() {
  const r = await fetch(API + '/api/audit?limit=10');
  const j = await r.json();
  document.getElementById('audit-result').style.display = 'block';
  document.getElementById('audit-result').textContent = JSON.stringify(j, null, 2);
}

async function doCreate() {
  const name = document.getElementById('new-name').value;
  const phone = document.getElementById('new-phone').value;
  const tier = document.getElementById('new-tier').value;
  if (!name || !phone) return alert('กรอกข้อมูลให้ครบ');
  const r = await fetch(API + '/api/members', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone, tier })
  });
  const j = await r.json();
  document.getElementById('create-result').style.display = 'block';
  document.getElementById('create-result').textContent = JSON.stringify(j, null, 2);
  loadMembers();
}

(async () => {
  await loadHealth();
  await loadMembers();
})();
</script>
</body>
</html>`);
});

// 404
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

// Vercel serverless export
module.exports = app;

// Local dev: listen if run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => {
    console.log('🚀 Likepoint 2.0 UAT Web App running at http://localhost:' + PORT);
  });
}
