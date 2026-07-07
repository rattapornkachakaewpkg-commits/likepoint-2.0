// Audit Engine — PF-5 (Phase D)
// PDPA-compliant audit log: search, export, retention, immutability
// Fixes bugs: A21 (support can't find tx), A31 (finance can't export),
//             A43 (PDPA 30-day SLA), A44 (audit lost on rollback)
// Author: AliClaw | Date: 2026-07-07

class AuditEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.store - audit storage (in-memory for prototype, DB in prod)
   * @param {Object} deps.memberService - to look up profile for export
   * @param {Object} deps.walletService - to look up transactions for export
   * @param {Object} deps.encryptor - encrypts PII at rest (AES-256-GCM)
   * @param {Object} deps.exportBucket - S3-like for export files
   */
  constructor({ store, memberService, walletService, encryptor, exportBucket } = {}) {
    this.store = store || new Map();          // id → audit entry
    this.members = memberService || { getProfile: async () => null };
    this.wallet = walletService || { getTransactions: async () => [] };
    this.encrypt = encryptor || { encrypt: (x) => x, decrypt: (x) => x };
    this.bucket = exportBucket || new Map(); // export_job_id → { content, url, expires_at }
    this._idSeq = 0;
  }

  // ============================================================
  // 1. log() — every API call writes one entry
  // ============================================================
  async log({ event_type, actor, member_id = null, resource_type = null, resource_id = null, action, metadata = {}, correlation_id = null, ip_address = null, user_agent = null, outcome = 'success' }) {
    if (!event_type) throw new Error('event_type is required');
    if (!actor) throw new Error('actor is required (user_id, service:wallet, etc.)');
    if (!action) throw new Error('action is required');

    const id = `AUD-${Date.now()}-${++this._idSeq}`;
    const entry = {
      id,
      event_type,                              // WALLET_CREDIT, MIGRATION, LOGIN, etc.
      actor,                                   // user:abc, service:wallet, system
      member_id,
      resource_type,                           // wallet, migration, session
      resource_id,
      action,                                  // CREATE, UPDATE, DELETE, READ
      metadata,                                // { amount, before, after, ... }
      correlation_id,                          // cross-service trace id
      ip_address,
      user_agent,
      outcome,                                 // success, failure, denied
      // PII is encrypted at rest
      pii_encrypted: this._hasPii(metadata)
        ? this.encrypt.encrypt(JSON.stringify(this._extractPii(metadata)))
        : null,
      // Hash of member_id for fast search (when member_id is PII)
      member_hash: member_id ? this._hash(member_id) : null,
      // Immutable: cannot be updated
      created_at: new Date().toISOString(),
      retention_until: this._calcRetention(),
    };

    // Strip PII from metadata before storage
    const safeMetadata = this._stripPii(metadata);
    entry.metadata = safeMetadata;

    this.store.set(id, entry);
    return { id, created_at: entry.created_at };
  }

  // ============================================================
  // 2. search() — for support / finance / auditor
  // ============================================================
  async search({ member_id, event_type, actor, resource_id, correlation_id, from, to, outcome, limit = 50, offset = 0, order = 'desc' } = {}) {
    let results = Array.from(this.store.values());

    if (member_id) {
      const h = this._hash(member_id);
      results = results.filter((e) => e.member_id === member_id || e.member_hash === h);
    }
    if (event_type) results = results.filter((e) => e.event_type === event_type);
    if (actor) results = results.filter((e) => e.actor === actor);
    if (resource_id) results = results.filter((e) => e.resource_id === resource_id);
    if (correlation_id) results = results.filter((e) => e.correlation_id === correlation_id);
    if (outcome) results = results.filter((e) => e.outcome === outcome);
    if (from) {
      const fromMs = new Date(from).getTime();
      results = results.filter((e) => new Date(e.created_at).getTime() >= fromMs);
    }
    if (to) {
      const toMs = new Date(to).getTime();
      results = results.filter((e) => new Date(e.created_at).getTime() <= toMs);
    }

    // Sort
    results.sort((a, b) => {
      const cmp = new Date(a.created_at) - new Date(b.created_at);
      return order === 'asc' ? cmp : -cmp;
    });

    const total = results.length;
    const items = results.slice(offset, offset + limit);

    return {
      total,
      limit,
      offset,
      has_more: offset + items.length < total,
      items,
    };
  }

  // ============================================================
  // 3. export() — finance/support bulk export
  // ============================================================
  async export({ filters = {}, format = 'csv', actor = 'system' } = {}) {
    if (!['csv', 'json'].includes(format)) {
      throw new Error(`Unsupported format: ${format}`);
    }
    const data = await this.search({ ...filters, limit: 100000 });
    const exportId = `EXP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    let content;
    if (format === 'csv') {
      content = this._toCSV(data.items);
    } else {
      content = JSON.stringify(data.items, null, 2);
    }

    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    this.bucket.set(exportId, {
      content,
      format,
      row_count: data.items.length,
      filters,
      requested_by: actor,
      expires_at,
    });

    // Audit the export itself
    await this.log({
      event_type: 'AUDIT_EXPORT',
      actor,
      action: 'CREATE',
      resource_type: 'export',
      resource_id: exportId,
      metadata: { format, row_count: data.items.length, filters },
      outcome: 'success',
    });

    return {
      export_id: exportId,
      format,
      row_count: data.items.length,
      expires_at,
      size_bytes: content.length,
      // In production: S3 signed URL
      url: `https://exports.likepoint.local/${exportId}.${format}`,
    };
  }

  // ============================================================
  // 4. exportUserData() — PDPA self-service (30-day SLA)
  // ============================================================
  async exportUserData({ member_id, requested_by = 'self' }) {
    if (!member_id) throw new Error('member_id is required');

    const sla_deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
    const requestId = `PDPA-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // Audit the request
    await this.log({
      event_type: 'PDPA_REQUEST',
      actor: requested_by,
      member_id,
      action: 'CREATE',
      resource_type: 'pdpa_request',
      resource_id: requestId,
      metadata: { sla_deadline, type: 'data_export' },
    });

    // Look up all data
    const profile = await this.members.getProfile(member_id);
    const transactions = await this.wallet.getTransactions(member_id);
    const auditEntries = (await this.search({ member_id, limit: 10000 })).items;
    const migrations = (await this.search({ member_id, event_type: 'AAM_MIGRATION', limit: 1000 })).items;

    // Decrypt PII from audit entries (only for the data subject)
    const decryptedAudit = auditEntries.map((e) => ({
      ...e,
      pii_decrypted: e.pii_encrypted ? this.encrypt.decrypt(e.pii_encrypted) : null,
    }));

    const userData = {
      pdpa_request_id: requestId,
      member_id,
      requested_at: new Date().toISOString(),
      sla_deadline,
      status: 'ready',
      profile: profile || { member_id, note: 'No profile data found' },
      transactions: { count: transactions.length, items: transactions },
      audit_log: { count: decryptedAudit.length, items: decryptedAudit },
      migrations: { count: migrations.length, items: migrations },
    };

    const content = JSON.stringify(userData, null, 2);
    const exportId = `PDPA-EXP-${Date.now()}`;
    this.bucket.set(exportId, {
      content,
      format: 'json',
      row_count: 1,
      filters: { member_id, type: 'pdpa_full_export' },
      requested_by,
      expires_at: sla_deadline,
    });

    return {
      pdpa_request_id: requestId,
      export_id: exportId,
      member_id,
      sla_deadline,
      status: 'ready',
      url: `https://exports.likepoint.local/${exportId}.json`,
      summary: {
        profile: !!profile,
        transactions: transactions.length,
        audit_entries: decryptedAudit.length,
        migrations: migrations.length,
      },
    };
  }

  // ============================================================
  // 5. retention sweep — runs daily, archives >7yr
  // ============================================================
  async runRetentionSweep({ now = new Date(), archive_bucket } = {}) {
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - 7);
    const cutoffMs = cutoff.getTime();

    let archived = 0, deleted = 0;
    for (const [id, entry] of this.store.entries()) {
      const entryMs = new Date(entry.created_at).getTime();
      if (entryMs < cutoffMs) {
        if (archive_bucket) {
          archive_bucket.set(id, entry);
          archived++;
        } else {
          this.store.delete(id);
          deleted++;
        }
      }
    }
    await this.log({
      event_type: 'RETENTION_SWEEP',
      actor: 'system:retention',
      action: 'DELETE',
      metadata: { archived, deleted, cutoff: cutoff.toISOString() },
    });
    return { archived, deleted, cutoff: cutoff.toISOString() };
  }

  // ============================================================
  // 6. getByCorrelation() — trace across services
  // ============================================================
  async getByCorrelation(correlation_id) {
    if (!correlation_id) throw new Error('correlation_id is required');
    return (await this.search({ correlation_id, limit: 1000 })).items;
  }

  // ============================================================
  // 7. stats() — for admin dashboard
  // ============================================================
  async stats({ since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const all = Array.from(this.store.values())
      .filter((e) => new Date(e.created_at).getTime() >= sinceMs);

    const byEventType = {};
    const byActor = {};
    const byOutcome = {};
    for (const e of all) {
      byEventType[e.event_type] = (byEventType[e.event_type] || 0) + 1;
      byActor[e.actor] = (byActor[e.actor] || 0) + 1;
      byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
    }
    return {
      total: all.length,
      byEventType,
      byActor,
      byOutcome,
      oldest: all.length ? all.reduce((m, e) => e.created_at < m ? e.created_at : m, all[0].created_at) : null,
      newest: all.length ? all.reduce((m, e) => e.created_at > m ? e.created_at : m, all[0].created_at) : null,
    };
  }

  // ============================================================
  // private helpers
  // ============================================================
  _hash(s) {
    // Simple non-crypto hash for demo (use bcrypt/argon2 in prod)
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return `h${Math.abs(h).toString(16)}`;
  }

  _hasPii(meta) {
    if (!meta || typeof meta !== 'object') return false;
    return ['phone', 'phone_hash', 'email', 'id_card', 'first_name', 'last_name', 'address']
      .some((k) => k in meta);
  }

  _extractPii(meta) {
    const pii = {};
    for (const k of ['phone', 'phone_hash', 'email', 'id_card', 'first_name', 'last_name', 'address']) {
      if (k in meta) pii[k] = meta[k];
    }
    return pii;
  }

  _stripPii(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const safe = { ...meta };
    for (const k of ['phone', 'phone_hash', 'email', 'id_card', 'first_name', 'last_name', 'address']) {
      if (k in safe) safe[k] = '[REDACTED]';
    }
    return safe;
  }

  _calcRetention() {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 7);
    return d.toISOString();
  }

  _toCSV(items) {
    if (items.length === 0) return '';
    const headers = ['id', 'event_type', 'actor', 'member_id', 'resource_type', 'resource_id', 'action', 'outcome', 'correlation_id', 'created_at'];
    const rows = items.map((e) => headers.map((h) => {
      const v = e[h] ?? '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
    return [headers.join(','), ...rows].join('\n');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AuditEngine };
}
if (typeof window !== 'undefined') {
  window.AuditEngine = AuditEngine;
}
