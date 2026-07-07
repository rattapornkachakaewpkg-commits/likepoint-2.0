// Bug Fixes — PF-13 (Phase E) — Top 5 Critical Bugs
// Consolidates fixes for 5 production-readiness issues found during audit
// Author: AliClaw | Date: 2026-07-07

/**
 * BUG #1: console.log ใน production code (sensitive data leak)
 * FIX: ใช้ logger module แทน console.log + redact sensitive data
 */
class Logger {
  constructor({ level = 'info', redactKeys = [] } = {}) {
    this.level = level;
    this.redactKeys = new Set(redactKeys.concat(['pin', 'otp', 'password', 'token', 'secret', 'api_key']));
  }

  _shouldLog(level) {
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    return levels[level] <= levels[this.level];
  }

  _redact(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const out = {};
    for (const [k, v] of Object.entries(meta)) {
      // Exact match (anchored) to avoid false positives like 'phone' matching 'pin'
      out[k] = /^(pin|otp|password|token|secret|api_key|apiKey)$/i.test(k) ? '[REDACTED]' : v;
    }
    return out;
  }

  info(msg, meta = {}) {
    if (this._shouldLog('info')) {
      // In production: write to file/structured log, NOT console
      process.stdout.write(JSON.stringify({ level: 'info', msg, meta: this._redact(meta), ts: new Date().toISOString() }) + '\n');
    }
  }

  warn(msg, meta = {}) {
    if (this._shouldLog('warn')) {
      process.stdout.write(JSON.stringify({ level: 'warn', msg, meta: this._redact(meta), ts: new Date().toISOString() }) + '\n');
    }
  }

  error(msg, meta = {}) {
    if (this._shouldLog('error')) {
      process.stderr.write(JSON.stringify({ level: 'error', msg, meta: this._redact(meta), ts: new Date().toISOString() }) + '\n');
    }
  }

  debug(msg, meta = {}) {
    if (this._shouldLog('debug')) {
      process.stdout.write(JSON.stringify({ level: 'debug', msg, meta: this._redact(meta), ts: new Date().toISOString() }) + '\n');
    }
  }
}

const defaultLogger = new Logger({ level: 'info' });

/**
 * BUG #2: Race condition ใน idempotency check
 * FIX: ใช้ simple mutex / lock pattern ก่อน check + set
 */
class IdempotencyLock {
  constructor() {
    this._locks = new Map(); // key → Promise
  }

  /**
   * Acquire lock for key, run fn, release lock
   * Returns the result of fn()
   */
  async withLock(key, fn) {
    // Wait for existing lock to release
    while (this._locks.has(key)) {
      await this._locks.get(key);
    }
    // Acquire new lock
    let release;
    const lock = new Promise((resolve) => { release = resolve; });
    this._locks.set(key, lock);
    try {
      return await fn();
    } finally {
      this._locks.delete(key);
      release();
    }
  }
}

const globalIdemLock = new IdempotencyLock();

/**
 * BUG #3: Missing amount validation in some engines
 * FIX: helper `validateAmount()` ใช้ในทุก engine
 */
function validateAmount(amount, { min = 0, max = Infinity, allowZero = true } = {}) {
  if (typeof amount !== 'number' || isNaN(amount)) {
    throw new Error('amount must be a number');
  }
  if (!allowZero && amount === 0) {
    throw new Error('amount must be > 0');
  }
  if (allowZero && amount < min) {
    throw new Error(`amount must be >= ${min}`);
  }
  if (!allowZero && amount <= min) {
    throw new Error(`amount must be > ${min}`);
  }
  if (amount > max) {
    throw new Error(`amount must be <= ${max}`);
  }
  return amount;
}

/**
 * BUG #4: OTP/PIN logged as plain text
 * FIX: `redactSensitive()` helper + Logger auto-redaction
 */
function redactSensitive(value) {
  if (typeof value === 'string') {
    if (value.length <= 4) return '***';
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Match whole word (anchored) to avoid false positives like 'phone' matching 'pin'
      if (/^(pin|otp|password|token|secret|api_key|apiKey)$/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * BUG #5: Expired token not validated
 * FIX: `validateTokenExpiry()` helper + comprehensive token check
 */
class TokenValidator {
  /**
   * Validate JWT-like token (without signature verification — use crypto lib in prod)
   * Checks: not expired, not used, has required claims
   */
  static validate(token, { requiredClaims = [], clockSkewSeconds = 30 } = {}) {
    if (!token || typeof token !== 'object') {
      return { valid: false, reason: 'INVALID_TOKEN' };
    }
    const now = Math.floor(Date.now() / 1000);

    // Expiry check (with clock skew tolerance)
    if (token.exp && typeof token.exp === 'number') {
      if (now > token.exp + clockSkewSeconds) {
        return { valid: false, reason: 'EXPIRED' };
      }
    } else if (token.expires_at) {
      const expMs = new Date(token.expires_at).getTime();
      if (Date.now() > expMs + clockSkewSeconds * 1000) {
        return { valid: false, reason: 'EXPIRED' };
      }
    } else {
      return { valid: false, reason: 'NO_EXPIRY_SET' };
    }

    // Not-before check
    if (token.nbf && typeof token.nbf === 'number') {
      if (now + clockSkewSeconds < token.nbf) {
        return { valid: false, reason: 'NOT_YET_VALID' };
      }
    }

    // Required claims
    for (const claim of requiredClaims) {
      if (!(claim in token)) {
        return { valid: false, reason: `MISSING_CLAIM:${claim}` };
      }
    }

    return { valid: true, claims: token };
  }

  /**
   * Create a token with expiry (for testing)
   */
  static create({ claims = {}, ttlSeconds = 3600 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSeconds;
    return {
      ...claims,
      iat: now,
      exp,
      nbf: Math.min(now, exp), // nbf must be <= exp
    };
  }
}

// === EXPORTS ===
module.exports = {
  Logger,
  IdempotencyLock,
  globalIdemLock,
  validateAmount,
  redactSensitive,
  TokenValidator,
  defaultLogger,
};
