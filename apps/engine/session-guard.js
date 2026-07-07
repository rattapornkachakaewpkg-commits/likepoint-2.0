// Session Guard & Idempotency Middleware — PF-14 (Phase E)
// Apply PF-13 bug-fixes (Logger, IdempotencyLock, TokenValidator, validateAmount)
// as production middleware layer for all API endpoints
// Author: AliClaw | Date: 2026-07-07

const { Logger, IdempotencyLock, validateAmount, TokenValidator, redactSensitive } = require('./bug-fixes.js');

class SessionGuard {
  /**
   * @param {Object} deps
   * @param {Object} deps.sessionStore - in-memory session storage (replace Redis in prod)
   * @param {Object} deps.idempotencyStore - in-memory idempotency store (replace DB in prod)
   * @param {Object} deps.auditEngine
   * @param {Object} deps.eventBus
   * @param {Object} deps.logger - optional custom logger
   */
  constructor({ sessionStore, idempotencyStore, auditEngine, eventBus, logger } = {}) {
    this.sessions = sessionStore || new Map();
    this.idem = idempotencyStore || new Map();
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.logger = logger || new Logger({ level: 'info' });
    this.idemLock = new IdempotencyLock();
    this._idSeq = 0;
  }

  // ============================================================
  // 1. withIdempotency() — middleware: prevent duplicate execution
  // ============================================================
  async withIdempotency({ key, ttlSeconds = 300, onHit, onMiss }) {
    if (!key) throw new Error('idempotency key is required');
    return this.idemLock.withLock(key, async () => {
      const existing = this.idem.get(key);
      if (existing && Date.now() - existing.created_at < ttlSeconds * 1000) {
        this.logger.info('idempotency hit', { key });
        if (onHit) return onHit(existing);
        return { hit: true, result: existing.result };
      }
      const result = await onMiss();
      this.idem.set(key, { result, created_at: Date.now() });
      // Auto-expire
      setTimeout(() => this.idem.delete(key), ttlSeconds * 1000).unref?.();
      this.logger.info('idempotency miss', { key });
      return { hit: false, result };
    });
  }

  // ============================================================
  // 2. requireAuth() — middleware: validate token before handler
  // ============================================================
  async requireAuth({ token, requiredClaims = ['sub'], clockSkewSeconds = 30 }) {
    if (!token) {
      this.logger.warn('auth rejected: no token');
      return { ok: false, status: 401, reason: 'MISSING_TOKEN' };
    }
    const check = TokenValidator.validate(token, { requiredClaims, clockSkewSeconds });
    if (!check.valid) {
      this.logger.warn('auth rejected', { reason: check.reason });
      return { ok: false, status: 401, reason: check.reason };
    }
    return { ok: true, claims: check.claims };
  }

  // ============================================================
  // 3. requireFeature() — middleware: gate handler by feature
  // ============================================================
  async requireFeature({ member, feature, minTier = null }) {
    if (!member) {
      this.logger.warn('feature gate rejected: no member');
      return { ok: false, status: 401, reason: 'NO_MEMBER' };
    }
    if (minTier) {
      const tierRank = { free: 0, pro: 2, enterprise: 3 };
      const userRank = tierRank[member.tier] ?? 0;
      const needRank = tierRank[minTier] ?? 0;
      if (userRank < needRank) {
        this.logger.warn('feature gate rejected: tier too low', { user: member.tier, need: minTier });
        return { ok: false, status: 403, reason: `REQUIRES_TIER_${minTier.toUpperCase()}` };
      }
    }
    if (feature) {
      const features = member.features || [];
      if (!features.includes(feature)) {
        this.logger.warn('feature gate rejected: missing feature', { feature });
        return { ok: false, status: 403, reason: `REQUIRES_FEATURE_${feature.toUpperCase()}` };
      }
    }
    return { ok: true };
  }

  // ============================================================
  // 4. validateSession() — middleware: timeout, IP, device
  // ============================================================
  async validateSession({ session_id, current_ip, current_device_id, maxAgeSeconds = 3600, requireSameIp = true, requireSameDevice = true }) {
    if (!session_id) {
      return { ok: false, status: 401, reason: 'NO_SESSION' };
    }
    const session = this.sessions.get(session_id);
    if (!session) {
      return { ok: false, status: 401, reason: 'INVALID_SESSION' };
    }
    const ageSeconds = (Date.now() - session.created_at) / 1000;
    if (ageSeconds > maxAgeSeconds) {
      this.sessions.delete(session_id);
      this.logger.warn('session expired', { session_id, age: ageSeconds });
      return { ok: false, status: 401, reason: 'EXPIRED_SESSION' };
    }
    if (requireSameIp && session.ip_address && current_ip && session.ip_address !== current_ip) {
      this.logger.warn('session IP mismatch', { session_id });
      return { ok: false, status: 401, reason: 'IP_MISMATCH' };
    }
    if (requireSameDevice && session.device_id && current_device_id && session.device_id !== current_device_id) {
      this.logger.warn('session device mismatch', { session_id });
      return { ok: false, status: 401, reason: 'DEVICE_MISMATCH' };
    }
    return { ok: true, session };
  }

  // ============================================================
  // 5. createSession() — create a new session after auth
  // ============================================================
  async createSession({ member_id, ip_address, device_id, metadata = {} }) {
    if (!member_id) throw new Error('member_id is required');
    const session_id = `SES-${Date.now()}-${++this._idSeq}`;
    const session = {
      session_id,
      member_id,
      ip_address: ip_address || null,
      device_id: device_id || null,
      metadata,
      created_at: Date.now(),
      last_seen_at: Date.now(),
    };
    this.sessions.set(session_id, session);
    await this.audit.log({
      event_type: 'SESSION_CREATED',
      actor: member_id,
      resource_type: 'session',
      resource_id: session_id,
      action: 'CREATE',
      metadata: { ip_address, device_id },
    });
    return session;
  }

  // ============================================================
  // 6. touchSession() — update last_seen_at
  // ============================================================
  async touchSession({ session_id }) {
    const session = this.sessions.get(session_id);
    if (!session) return null;
    session.last_seen_at = Date.now();
    return session;
  }

  // ============================================================
  // 7. destroySession() — logout
  // ============================================================
  async destroySession({ session_id, reason = 'user_logout' }) {
    const session = this.sessions.get(session_id);
    if (!session) return false;
    this.sessions.delete(session_id);
    await this.audit.log({
      event_type: 'SESSION_DESTROYED',
      actor: session.member_id,
      resource_type: 'session',
      resource_id: session_id,
      action: 'DELETE',
      metadata: { reason },
    });
    return true;
  }

  // ============================================================
  // 8. withGuard() — combined middleware: auth + session + idempotency
  // ============================================================
  async withGuard({ token, session_id, ip_address, device_id, idempotency_key, requiredClaims = ['sub'], requiredFeature = null, minTier = null, maxAgeSeconds = 3600, handler }) {
    // 1. Auth check
    const auth = await this.requireAuth({ token, requiredClaims });
    if (!auth.ok) return auth;

    // 2. Session check
    const session = await this.validateSession({ session_id, current_ip: ip_address, current_device_id: device_id, maxAgeSeconds });
    if (!session.ok) return session;

    // 3. Feature gate
    if (requiredFeature || minTier) {
      const member = { id: auth.claims.sub, tier: session.session.metadata?.tier, features: session.session.metadata?.features || [] };
      const feat = await this.requireFeature({ member: { member_id: member.id, ...member }, feature: requiredFeature, minTier });
      if (!feat.ok) return feat;
    }

    // 4. Idempotency
    if (idempotency_key) {
      return this.withIdempotency({
        key: idempotency_key,
        onHit: (existing) => ({ ok: true, status: 200, body: { idempotent: true, result: existing.result } }),
        onMiss: async () => {
          const result = await handler({ claims: auth.claims, session: session.session });
          await this.touchSession({ session_id });
          return { ok: true, status: 200, body: { idempotent: false, result } };
        },
      });
    }

    // 5. No idempotency, just call handler
    const result = await handler({ claims: auth.claims, session: session.session });
    await this.touchSession({ session_id });
    return { ok: true, status: 200, body: { result } };
  }

  // ============================================================
  // helpers
  // ============================================================
  getStats() {
    return {
      active_sessions: this.sessions.size,
      active_idempotency_keys: this.idem.size,
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SessionGuard };
}
if (typeof window !== 'undefined') {
  window.SessionGuard = SessionGuard;
}
