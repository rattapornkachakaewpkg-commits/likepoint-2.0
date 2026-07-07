// API Integration Layer — PF-21 (Phase E)
// Wraps engines with SessionGuard + Bug Fixes (PF-13) + i18n (PF-18)
// Provides standardized API endpoints that all engines can use
// Author: AliClaw | Date: 2026-07-07

const { SessionGuard } = require('./session-guard.js');
const { Logger, validateAmount, redactSensitive } = require('./bug-fixes.js');

class APIIntegrationLayer {
  /**
   * @param {Object} deps
   * @param {Object} deps.sessionGuard - PF-14
   * @param {Object} deps.auditEngine - PF-5
   * @param {Object} deps.logger - PF-13
   * @param {Object} deps.memberService
   */
  constructor({ sessionGuard, auditEngine, logger, memberService } = {}) {
    this.guard = sessionGuard || new SessionGuard();
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.logger = logger || new Logger({ level: 'info' });
    this.members = memberService || { get: async () => null };
  }

  /**
   * Wrap any engine method with SessionGuard middleware
   * Standardized: auth + session + feature gate + idempotency
   */
  async protectedHandler({ token, session_id, ip_address, device_id, idempotency_key, requiredFeature, minTier, engine, method, args = [], metadata = {} }) {
    // 1. Auth
    const auth = await this.guard.requireAuth({ token, requiredClaims: ['sub'] });
    if (!auth.ok) {
      this.logger.warn('Auth failed', { reason: auth.reason, method: `${engine}.${method}` });
      return { status: auth.status, body: { error: auth.reason } };
    }

    // 2. Session
    const session = await this.guard.validateSession({ session_id, current_ip: ip_address, current_device_id: device_id });
    if (!session.ok) {
      this.logger.warn('Session failed', { reason: session.reason });
      return { status: session.status, body: { error: session.reason } };
    }

    // 3. Feature gate
    if (requiredFeature || minTier) {
      const member = await this.members.get?.(auth.claims.sub);
      const feature = await this.guard.requireFeature({
        member: { member_id: auth.claims.sub, tier: session.session.metadata?.tier, features: session.session.metadata?.features || [] },
        feature: requiredFeature, minTier,
      });
      if (!feature.ok) {
        this.logger.warn('Feature gate failed', { reason: feature.reason });
        return { status: feature.status, body: { error: feature.reason } };
      }
    }

    // 4. Idempotency
    if (idempotency_key) {
      return this.guard.withIdempotency({
        key: idempotency_key,
        onHit: (existing) => ({ status: 200, body: { idempotent: true, result: existing.result } }),
        onMiss: async () => {
          const result = await this._invokeEngine(engine, method, args, auth, session, metadata);
          await this.guard.touchSession({ session_id });
          return { status: 200, body: { idempotent: false, result } };
        },
      });
    }

    // 5. Execute
    const result = await this._invokeEngine(engine, method, args, auth, session, metadata);
    await this.guard.touchSession({ session_id });
    return { status: 200, body: { result } };
  }

  /**
   * Engine invocation helper — apply logging + audit + error handling
   */
  async _invokeEngine(engine, method, args, auth, session, metadata) {
    const start = Date.now();
    try {
      const result = await engine[method](...args);
      const duration = Date.now() - start;
      this.logger.info('Engine call success', {
        engine: engine.constructor.name,
        method, member: auth.claims.sub, duration_ms: duration,
      });
      await this.audit.log({
        event_type: 'API_CALL_SUCCESS', actor: auth.claims.sub,
        resource_type: 'api', resource_id: `${engine.constructor.name}.${method}`,
        action: 'CREATE', metadata: { ...metadata, duration_ms: duration },
      });
      return result;
    } catch (e) {
      const duration = Date.now() - start;
      this.logger.error('Engine call failed', {
        engine: engine.constructor.name, method, error: redactSensitive(e.message), duration_ms: duration,
      });
      await this.audit.log({
        event_type: 'API_CALL_FAILED', actor: auth.claims.sub,
        resource_type: 'api', resource_id: `${engine.constructor.name}.${method}`,
        action: 'CREATE', metadata: { error: e.message, duration_ms: duration },
      });
      throw e;
    }
  }

  /**
   * Validate amount helper (PF-13 utility)
   */
  validateAmount(amount, options) {
    return validateAmount(amount, options);
  }

  /**
   * Redact sensitive data helper (PF-13 utility)
   */
  redact(value) {
    return redactSensitive(value);
  }

  /**
   * Health check endpoint
   */
  async healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      session_guard: this.guard ? 'ready' : 'not_initialized',
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { APIIntegrationLayer };
}
if (typeof window !== 'undefined') {
  window.APIIntegrationLayer = APIIntegrationLayer;
}
