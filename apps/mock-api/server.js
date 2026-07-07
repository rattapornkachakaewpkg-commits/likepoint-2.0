// Mock API Server — จำลอง MS24 + Mini Like + PP7 สำหรับทดสอบ Rebind Engine
// Phase B: PF-2 (Wallet Rebinding Engine)
// Date: 2026-07-07
// Author: AliClaw

const express = require('express');
const app = express();
app.use(express.json());

// =================== MOCK DATA ===================
// 3 ระบบจำลอง — แต่ละระบบมี data แยกกัน (Island Data)

let ms24DB = {
  // MS24 = Master (person_id + phone)
  'usr_001': { person_id: 'usr_001', name: 'สมชาย ใจดี', phone: '088-1234-5678', phone_hash: 'h_old_001' },
  'usr_002': { person_id: 'usr_002', name: 'สมหญิง รักไทย', phone: '088-9999-8888', phone_hash: 'h_002' },
  'usr_003': { person_id: 'usr_003', name: 'ใจดี มีสุข', phone: '088-7777-6666', phone_hash: 'h_003' }
};

let miniLikeDB = {
  // Mini Like = Consumer (wallets)
  wallets: {
    'wlt_001': { 
      wallet_id: 'wlt_001', 
      person_id: 'usr_001', 
      phone_hash: 'h_old_001', 
      msp_balance: 8200, 
      status: 'ACTIVE',
      created_at: '2026-01-15T10:00:00Z'
    },
    'wlt_002': { 
      wallet_id: 'wlt_002', 
      person_id: 'usr_002', 
      phone_hash: 'h_002', 
      msp_balance: 4250, 
      status: 'ACTIVE',
      created_at: '2026-02-20T10:00:00Z'
    }
    // usr_003 ยังไม่มี wallet
  }
};

let pp7DB = {
  // PP7 = Member (tier)
  'usr_001': { person_id: 'usr_001', tier: 'GOLD', last_sync_at: null },
  'usr_002': { person_id: 'usr_002', tier: 'SILVER', last_sync_at: null }
};

let eventLog = [];  // log events ทั้งหมด
let rebindLog = []; // log การ rebind wallet

// =================== MS24 API (Read-only) ===================
// GET /api/ms24/person/:phone
app.get('/api/ms24/person/:phone', (req, res) => {
  const phone = req.params.phone;
  const person = Object.values(ms24DB).find(p => p.phone === phone);
  if (!person) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(person);
});

// POST /api/ms24/webhook/phone-changed
// (MS24 ส่ง event เมื่อสมาชิกเปลี่ยนเบอร์)
app.post('/api/ms24/webhook/phone-changed', (req, res) => {
  const { person_id, old_phone_hash, new_phone_hash, new_phone } = req.body;
  
  // Validate
  if (!person_id || !old_phone_hash || !new_phone_hash) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }
  
  // Update MS24
  if (ms24DB[person_id]) {
    ms24DB[person_id].phone = new_phone;
    ms24DB[person_id].phone_hash = new_phone_hash;
  }
  
  // Log event
  const event = {
    type: 'PHONE_CHANGED',
    person_id,
    old_phone_hash,
    new_phone_hash,
    new_phone,
    timestamp: new Date().toISOString()
  };
  eventLog.push(event);
  
  console.log(`📞 [MS24] Phone changed: ${person_id} (${old_phone_hash} → ${new_phone_hash})`);
  res.json({ success: true, event });
});

// =================== Mini Like API ===================
// GET /api/mini-like/wallets/:person_id
app.get('/api/mini-like/wallets/:person_id', (req, res) => {
  const personId = req.params.person_id;
  const wallets = Object.values(miniLikeDB.wallets).filter(w => w.person_id === personId);
  res.json({ wallets });
});

// GET /api/mini-like/wallet/:wallet_id
app.get('/api/mini-like/wallet/:wallet_id', (req, res) => {
  const wallet = miniLikeDB.wallets[req.params.wallet_id];
  if (!wallet) return res.status(404).json({ error: 'WALLET_NOT_FOUND' });
  res.json(wallet);
});

// =================== PP7 API ===================
// GET /api/pp7/member/:person_id
app.get('/api/pp7/member/:person_id', (req, res) => {
  const member = pp7DB[req.params.person_id];
  if (!member) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(member);
});

// PATCH /api/pp7/member/:person_id (sync tier)
app.patch('/api/pp7/member/:person_id', (req, res) => {
  const { tier } = req.body;
  if (pp7DB[req.params.person_id]) {
    pp7DB[req.params.person_id].tier = tier;
    pp7DB[req.params.person_id].last_sync_at = new Date().toISOString();
  }
  res.json({ success: true });
});

// =================== REBIND API (เรียกจาก Engine) ===================
// POST /api/mini-like/wallet/rebind
app.post('/api/mini-like/wallet/rebind', (req, res) => {
  const { wallet_id, person_id, old_phone_hash, new_phone_hash } = req.body;
  const wallet = miniLikeDB.wallets[wallet_id];
  
  if (!wallet) return res.status(404).json({ error: 'WALLET_NOT_FOUND' });
  if (wallet.person_id !== person_id) return res.status(403).json({ error: 'PERSON_MISMATCH' });
  if (wallet.phone_hash !== old_phone_hash) return res.status(409).json({ error: 'PHONE_HASH_MISMATCH' });
  
  // Rebind
  wallet.phone_hash = new_phone_hash;
  
  // Log
  rebindLog.push({
    action: 'REBIND',
    wallet_id,
    person_id,
    old_phone_hash,
    new_phone_hash,
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true, wallet });
});

// GET /api/rebind-log
app.get('/api/rebind-log', (req, res) => {
  res.json({ log: rebindLog, count: rebindLog.length });
});

// =================== EVENT LOG (debug) ===================
app.get('/api/events', (req, res) => {
  res.json({ events: eventLog, count: eventLog.length });
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    service: 'Mock API Server (PF-2 Testing)',
    endpoints: [
      'GET  /api/ms24/person/:phone',
      'POST /api/ms24/webhook/phone-changed',
      'GET  /api/mini-like/wallets/:person_id',
      'POST /api/mini-like/wallet/rebind',
      'GET  /api/pp7/member/:person_id',
      'GET  /api/rebind-log',
      'GET  /api/events'
    ]
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Mock API Server running on port ${PORT}`);
  console.log(`📊 Test: curl http://localhost:${PORT}/`);
});
