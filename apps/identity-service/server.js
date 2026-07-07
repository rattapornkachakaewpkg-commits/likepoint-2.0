// Identity Service — HTTP API Server
// Author: AliClaw | Date: 2026-07-07

const express = require('express');
const { IdentityService } = require('./member.js');

const app = express();
app.use(express.json());

// In-memory DB (mock) — production ควรใช้ PostgreSQL
const db = {
  members: new Map(),
  phone_bindings: new Map(),
  device_bindings: new Map(),
  login_history: new Map(),
  consents: new Map()
};

class AuditLog {
  constructor() { this.records = []; }
  async record(data) { this.records.push(data); }
}

const audit = new AuditLog();
const identity = new IdentityService({ db, auditLog: audit });

// =================== ENDPOINTS ===================

// Member CRUD
app.post('/api/identity/members', async (req, res) => {
  try {
    const { display_name, phone_hash, phone_last4 } = req.body;
    const result = await identity.createMember({ display_name, phone_hash, phone_last4 });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/identity/members/:member_id', async (req, res) => {
  const member = await identity.getMember(req.params.member_id);
  if (!member) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
  res.json(member);
});

app.get('/api/identity/members/by-phone/:phone_hash', async (req, res) => {
  const member = await identity.getMemberByPhone(req.params.phone_hash);
  if (!member) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
  res.json(member);
});

app.patch('/api/identity/members/:member_id', async (req, res) => {
  try {
    const member = await identity.updateMember(req.params.member_id, req.body);
    res.json(member);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/identity/members/:member_id', async (req, res) => {
  try {
    const member = await identity.deleteMember(req.params.member_id);
    res.json(member);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Phone Bindings
app.post('/api/identity/phone-bindings', async (req, res) => {
  try {
    const { member_id, phone_hash, phone_last4, is_primary, status } = req.body;
    const binding = await identity.bindPhone({ member_id, phone_hash, phone_last4, is_primary, status });
    res.status(201).json(binding);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/identity/members/:member_id/phones', async (req, res) => {
  const phones = await identity.getPhonesForMember(req.params.member_id);
  res.json({ phones });
});

app.delete('/api/identity/phone-bindings/:binding_id', async (req, res) => {
  try {
    const result = await identity.unbindPhone(req.params.binding_id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Consent
app.post('/api/identity/consents', async (req, res) => {
  try {
    const { member_id, consent_type, granted } = req.body;
    const consent = await identity.recordConsent({ member_id, consent_type, granted });
    res.status(201).json(consent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/identity/consents/:consent_id', async (req, res) => {
  try {
    const consent = await identity.revokeConsent(req.params.consent_id);
    res.json(consent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'Identity Service (RFC-001)',
    stats: {
      members: db.members.size,
      phone_bindings: db.phone_bindings.size,
      consents: db.consents.size
    },
    endpoints: [
      'POST   /api/identity/members',
      'GET    /api/identity/members/:member_id',
      'GET    /api/identity/members/by-phone/:phone_hash',
      'PATCH  /api/identity/members/:member_id',
      'DELETE /api/identity/members/:member_id',
      'POST   /api/identity/phone-bindings',
      'GET    /api/identity/members/:member_id/phones',
      'DELETE /api/identity/phone-bindings/:binding_id',
      'POST   /api/identity/consents',
      'DELETE /api/identity/consents/:consent_id'
    ]
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`🚀 Identity Service running on port ${PORT}`);
  console.log(`📊 Test: curl http://localhost:${PORT}/`);
});
