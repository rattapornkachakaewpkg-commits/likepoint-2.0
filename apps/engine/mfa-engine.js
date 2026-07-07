// MFA Engine — PF-20 (Phase E)
// Multi-factor authentication: TOTP, SMS OTP, biometric, recovery codes
// Author: AliClaw | Date: 2026-07-07

class MFAEngine {
  constructor({ memberStore, factorStore, recoveryCodeStore, deviceStore, auditEngine, eventBus, notifier } = {}) {
    this.members = memberStore || new Map();
    this.factors = factorStore || new Map();
    this.recoveryCodes = recoveryCodeStore || new Map();
    this.devices = deviceStore || new Map();
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.notifier = notifier || { send: async () => ({ status: 'mock' }) };
    this._idSeq = 0;
  }

  // ============================================================
  // 1. enrollTOTP() — enroll TOTP (Google Authenticator, Authy)
  // ============================================================
  async enrollTOTP({ member_id, device_name = 'Mobile' }) {
    if (!member_id) throw new Error('member_id required');
    const secret = this._generateBase32Secret();
    const factor_id = `MFAT-${Date.now()}-${++this._idSeq}`;
    const factor = {
      factor_id, member_id, type: 'totp',
      secret, device_name,
      enrolled_at: new Date().toISOString(),
      last_used_at: null, status: 'active',
    };
    this.factors.set(factor_id, factor);
    await this.audit.log({
      event_type: 'MFA_TOTP_ENROLLED', actor: member_id,
      resource_type: 'mfa_factor', resource_id: factor_id,
      action: 'CREATE', metadata: { type: 'totp', device_name },
    });
    return { factor_id, secret, otpauth_url: `otpauth://totp/Likepoint:${member_id}?secret=${secret}&issuer=Likepoint` };
  }

  // ============================================================
  // 2. verifyTOTP() — verify 6-digit code from authenticator
  // ============================================================
  async verifyTOTP({ member_id, code, factor_id = null }) {
    if (!member_id || !code) throw new Error('member_id, code required');
    const factors = Array.from(this.factors.values()).filter(
      (f) => f.member_id === member_id && f.type === 'totp' && f.status === 'active'
    );
    const targets = factor_id ? factors.filter((f) => f.factor_id === factor_id) : factors;
    for (const f of targets) {
      if (this._verifyTOTPCode(f.secret, code)) {
        f.last_used_at = new Date().toISOString();
        return { verified: true, factor_id: f.factor_id };
      }
    }
    return { verified: false, reason: 'INVALID_CODE' };
  }

  // ============================================================
  // 3. enrollSMS() — enroll SMS OTP
  // ============================================================
  async enrollSMS({ member_id, phone }) {
    if (!member_id || !phone) throw new Error('member_id, phone required');
    const factor_id = `MFAS-${Date.now()}-${++this._idSeq}`;
    const factor = {
      factor_id, member_id, type: 'sms', phone,
      enrolled_at: new Date().toISOString(),
      last_used_at: null, status: 'active',
    };
    this.factors.set(factor_id, factor);
    await this.audit.log({
      event_type: 'MFA_SMS_ENROLLED', actor: member_id,
      resource_type: 'mfa_factor', resource_id: factor_id,
      action: 'CREATE', metadata: { phone: phone.slice(0, 3) + '***' },
    });
    return { factor_id, phone };
  }

  async sendSMSOTP({ member_id }) {
    const factors = Array.from(this.factors.values()).filter(
      (f) => f.member_id === member_id && f.type === 'sms' && f.status === 'active'
    );
    if (factors.length === 0) throw new Error('No SMS factor enrolled');
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const request_id = `MFAOTP-${Date.now()}-${++this._idSeq}`;
    const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.factors.set(request_id, {
      request_id, member_id, type: 'sms-otp', otp_hash: this._hash(otp),
      expires_at, factor_id: factors[0].factor_id, attempts: 0, verified: false,
    });
    await this.notifier.send({
      template_id: 'mfa-sms-otp', recipient: { member_id, phone: factors[0].phone },
      variables: { otp },
    });
    return { request_id, expires_at };
  }

  async verifySMSOTP({ request_id, otp }) {
    const req = this.factors.get(request_id);
    if (!req || req.type !== 'sms-otp') throw new Error('Invalid request');
    if (Date.now() > new Date(req.expires_at).getTime()) throw new Error('Expired');
    req.attempts++;
    if (this._hash(otp) !== req.otp_hash) throw new Error('Invalid OTP');
    req.verified = true;
    this.factors.delete(request_id); // single-use
    return { verified: true, factor_id: req.factor_id };
  }

  // ============================================================
  // 4. enrollBiometric() — enroll device biometric (TouchID, FaceID)
  // ============================================================
  async enrollBiometric({ member_id, device_id, biometric_type, public_key }) {
    if (!member_id || !device_id || !biometric_type) throw new Error('member_id, device_id, biometric_type required');
    if (!['fingerprint', 'face', 'voice'].includes(biometric_type)) throw new Error('Invalid biometric_type');
    const factor_id = `MFAB-${Date.now()}-${++this._idSeq}`;
    const factor = {
      factor_id, member_id, type: 'biometric', device_id, biometric_type, public_key,
      enrolled_at: new Date().toISOString(), status: 'active',
    };
    this.factors.set(factor_id, factor);
    // Also register trusted device
    this.devices.set(device_id, {
      device_id, member_id, biometric_type, trusted: true,
      last_seen_at: new Date().toISOString(),
    });
    await this.audit.log({
      event_type: 'MFA_BIOMETRIC_ENROLLED', actor: member_id,
      resource_type: 'mfa_factor', resource_id: factor_id,
      action: 'CREATE', metadata: { device_id, biometric_type },
    });
    return { factor_id, device_id };
  }

  async verifyBiometric({ member_id, device_id, signature }) {
    if (!member_id || !device_id || !signature) throw new Error('member_id, device_id, signature required');
    const factor = Array.from(this.factors.values()).find(
      (f) => f.member_id === member_id && f.type === 'biometric' && f.device_id === device_id && f.status === 'active'
    );
    if (!factor) return { verified: false, reason: 'NO_FACTOR' };
    if (this._verifySignature(factor.public_key, signature)) {
      // Update device last_seen
      const dev = this.devices.get(device_id);
      if (dev) dev.last_seen_at = new Date().toISOString();
      return { verified: true, factor_id: factor.factor_id };
    }
    return { verified: false, reason: 'INVALID_SIGNATURE' };
  }

  // ============================================================
  // 5. generateRecoveryCodes() — one-time backup codes
  // ============================================================
  async generateRecoveryCodes({ member_id, count = 10 }) {
    if (!member_id) throw new Error('member_id required');
    // Revoke old codes
    for (const [k, v] of this.recoveryCodes.entries()) {
      if (v.member_id === member_id && !v.used_at) this.recoveryCodes.delete(k);
    }
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = this._generateRecoveryCode();
      this.recoveryCodes.set(code, {
        code, member_id, used_at: null,
        created_at: new Date().toISOString(),
      });
      codes.push(code);
    }
    await this.audit.log({
      event_type: 'MFA_RECOVERY_CODES_GENERATED', actor: member_id,
      resource_type: 'mfa', resource_id: member_id,
      action: 'CREATE', metadata: { count },
    });
    return { codes, message: 'Save these codes in a safe place. Each can be used once.' };
  }

  async useRecoveryCode({ member_id, code }) {
    if (!member_id || !code) throw new Error('member_id, code required');
    const entry = this.recoveryCodes.get(code);
    if (!entry || entry.member_id !== member_id) throw new Error('Invalid code');
    if (entry.used_at) throw new Error('Code already used');
    entry.used_at = new Date().toISOString();
    await this.audit.log({
      event_type: 'MFA_RECOVERY_CODE_USED', actor: member_id,
      resource_type: 'mfa', resource_id: code,
      action: 'UPDATE', metadata: {},
    });
    return { verified: true, code };
  }

  // ============================================================
  // 6. listFactors() — show user's enrolled factors
  // ============================================================
  async listFactors({ member_id }) {
    const factors = Array.from(this.factors.values()).filter(
      (f) => f.member_id === member_id && !['sms-otp'].includes(f.type)
    );
    return {
      total: factors.length,
      factors: factors.map((f) => ({
        factor_id: f.factor_id, type: f.type, device_name: f.device_name || f.device_id,
        enrolled_at: f.enrolled_at, last_used_at: f.last_used_at, status: f.status,
      })),
    };
  }

  // ============================================================
  // 7. removeFactor() — disable a factor
  // ============================================================
  async removeFactor({ member_id, factor_id, actor = 'user' }) {
    const f = this.factors.get(factor_id);
    if (!f) throw new Error('Factor not found');
    if (f.member_id !== member_id) throw new Error('Cannot remove another user\'s factor');
    f.status = 'removed';
    f.removed_at = new Date().toISOString();
    await this.audit.log({
      event_type: 'MFA_FACTOR_REMOVED', actor,
      resource_type: 'mfa_factor', resource_id: factor_id,
      member_id, action: 'DELETE', metadata: { type: f.type },
    });
    return f;
  }

  // ============================================================
  // 8. getStatus() — MFA summary for member
  // ============================================================
  async getStatus({ member_id }) {
    const factors = Array.from(this.factors.values()).filter(
      (f) => f.member_id === member_id && f.status === 'active' && !['sms-otp'].includes(f.type)
    );
    const recoveryCodesRemaining = Array.from(this.recoveryCodes.values()).filter(
      (c) => c.member_id === member_id && !c.used_at
    ).length;
    return {
      enabled: factors.length > 0,
      factors_count: factors.length,
      has_totp: factors.some((f) => f.type === 'totp'),
      has_sms: factors.some((f) => f.type === 'sms'),
      has_biometric: factors.some((f) => f.type === 'biometric'),
      recovery_codes_remaining: recoveryCodesRemaining,
    };
  }

  // ============================================================
  // private
  // ============================================================
  _generateBase32Secret() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let s = '';
    for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  _generateRecoveryCode() {
    return Array.from({ length: 5 }, () =>
      String(Math.floor(1000 + Math.random() * 9000))
    ).join('-');
  }

  _verifyTOTPCode(secret, code) {
    // Simulated TOTP: accept code if it matches a time-based hash
    // In production: use otpauth library
    const window = 30; // 30s time step
    const now = Math.floor(Date.now() / 1000 / window);
    for (let offset = -1; offset <= 1; offset++) {
      const t = (now + offset) * window;
      // Simulated: hash from secret + time
      const expected = this._simulateTOTP(secret, t);
      if (expected === code) return true;
    }
    return false;
  }

  _simulateTOTP(secret, time) {
    // Simple hash for testing — NOT RFC 6238 compliant
    let h = 0;
    const s = secret + time;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(Math.abs(h) % 1000000).padStart(6, '0');
  }

  _verifySignature(publicKey, signature) {
    // Simulated signature verification
    return signature === `sig_${publicKey.slice(0, 8)}`;
  }

  _hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `h${Math.abs(h).toString(16)}`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MFAEngine };
}
if (typeof window !== 'undefined') {
  window.MFAEngine = MFAEngine;
}
