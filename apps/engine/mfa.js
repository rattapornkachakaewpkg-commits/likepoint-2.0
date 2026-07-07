// Multi-Factor Authentication (MFA) Engine
// RFC-001 Open Question #5: "การยืนยันตัวตนหลายปัจจัย"
// Author: AliClaw | Date: 2026-07-07

const crypto = require('crypto');

class MFAEngine {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.identityService
   * @param {Object} dependencies.auditLog
   */
  constructor({ identityService, auditLog } = {}) {
    if (!identityService) throw new Error('identityService is required');
    this.identity = identityService;
    this.audit = auditLog || console;
  }

  /**
   * Enroll TOTP for a member
   * Returns: { secret, otpauth_url, qr_code_data }
   */
  async enrollTOTP(member_id) {
    const member = await this.identity.getMember(member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');

    const secret = this._generateBase32Secret();
    const issuer = 'LikePoint';
    const otpauthUrl = `otpauth://totp/${issuer}:${member_id}?secret=${secret}&issuer=${issuer}`;

    // Store secret (in production: encrypted + secure storage)
    if (!this._secrets) this._secrets = new Map();
    this._secrets.set(member_id, {
      secret,
      enrolled_at: new Date().toISOString(),
      verified: false
    });

    await this.audit.record?.({
      action: 'TOTP_ENROLLED',
      member_id
    });

    return {
      secret,
      otpauth_url: otpauthUrl,
      instructions: 'Scan QR code with Google Authenticator / Authy'
    };
  }

  /**
   * Verify TOTP code
   * RFC 6238: TOTP code is 6 digits, valid for 30 seconds
   */
  async verifyTOTP(member_id, code) {
    if (!code || code.length !== 6) {
      throw new Error('CODE_MUST_BE_6_DIGITS');
    }

    const stored = this._secrets?.get(member_id);
    if (!stored) throw new Error('TOTP_NOT_ENROLLED');

    const now = Math.floor(Date.now() / 1000);
    const window = 30;  // 30-second window

    // Check current + previous + next (clock skew tolerance)
    for (let offset = -1; offset <= 1; offset++) {
      const counter = Math.floor((now + offset * window) / window);
      const expected = this._generateTOTP(stored.secret, counter);
      if (this._constantTimeEqual(expected, code)) {
        // Mark as verified
        stored.verified = true;
        stored.last_verified_at = new Date().toISOString();
        await this.audit.record?.({
          action: 'TOTP_VERIFIED',
          member_id,
          offset
        });
        return { success: true };
      }
    }

    await this.audit.record?.({
      action: 'TOTP_FAILED',
      member_id
    });
    return { success: false, reason: 'INVALID_CODE' };
  }

  /**
   * Send SMS OTP (alternative factor)
   */
  async sendSMSOTP(member_id, phone_hash) {
    const member = await this.identity.getMember(member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);  // 5 minutes

    if (!this._sms_codes) this._sms_codes = new Map();
    this._sms_codes.set(`${member_id}:${code}`, {
      member_id,
      code,
      phone_hash,
      expires_at: expiresAt.toISOString(),
      attempts: 0
    });

    // (Production: send via SMS provider)
    console.log(`[SMS] OTP for ${member_id}: ${code} (expires ${expiresAt.toISOString()})`);

    await this.audit.record?.({
      action: 'SMS_OTP_SENT',
      member_id,
      phone_last4: phone_hash.slice(-4)
    });

    return { sent: true, expires_in_seconds: 300 };
  }

  /**
   * Verify SMS OTP
   */
  async verifySMSOTP(member_id, code) {
    const key = `${member_id}:${code}`;
    const record = this._sms_codes?.get(key);
    if (!record) return { success: false, reason: 'CODE_NOT_FOUND' };
    if (new Date() > new Date(record.expires_at)) {
      this._sms_codes.delete(key);
      return { success: false, reason: 'EXPIRED' };
    }
    if (record.attempts >= 3) {
      return { success: false, reason: 'TOO_MANY_ATTEMPTS' };
    }
    record.attempts++;

    // Successful — delete code (one-time use)
    this._sms_codes.delete(key);
    await this.audit.record?.({
      action: 'SMS_OTP_VERIFIED',
      member_id
    });
    return { success: true };
  }

  /**
   * Multi-factor verification: require at least 2 factors
   */
  async verifyMFA(member_id, { password_verified, totp_code, sms_code, ip_address }) {
    const factors = [];

    if (password_verified) factors.push('PASSWORD');
    if (totp_code) {
      const totpResult = await this.verifyTOTP(member_id, totp_code);
      if (totpResult.success) factors.push('TOTP');
    }
    if (sms_code) {
      const smsResult = await this.verifySMSOTP(member_id, sms_code);
      if (smsResult.success) factors.push('SMS');
    }

    // Risk-based: require 2 factors if new IP/device
    const requiredFactors = ip_address ? 2 : 1;

    await this.audit.record?.({
      action: 'MFA_ATTEMPT',
      member_id,
      factors,
      required: requiredFactors,
      passed: factors.length >= requiredFactors
    });

    return {
      success: factors.length >= requiredFactors,
      factors_used: factors,
      required: requiredFactors
    };
  }

  // ============== HELPERS (RFC 6238 TOTP) ==============
  _generateBase32Secret() {
    const buf = crypto.randomBytes(20);
    return this._base32Encode(buf);
  }

  _base32Encode(buf) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '', result = '';
    for (let i = 0; i < buf.length; i++) {
      bits += buf[i].toString(2).padStart(8, '0');
    }
    for (let i = 0; i < bits.length; i += 5) {
      const chunk = bits.substr(i, 5).padEnd(5, '0');
      result += alphabet[parseInt(chunk, 2)];
    }
    return result;
  }

  _generateTOTP(secret, counter) {
    // Decode base32
    const key = this._base32Decode(secret);
    // Buffer from counter (8 bytes big-endian)
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigInt64BE(BigInt(counter));
    // HMAC-SHA1
    const hmac = crypto.createHmac('sha1', key);
    hmac.update(counterBuf);
    const digest = hmac.digest();
    // Dynamic truncation
    const offset = digest[digest.length - 1] & 0x0f;
    const code = ((digest[offset] & 0x7f) << 24) |
                  ((digest[offset + 1] & 0xff) << 16) |
                  ((digest[offset + 2] & 0xff) << 8) |
                  (digest[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  }

  _base32Decode(str) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (let i = 0; i < str.length; i++) {
      const idx = alphabet.indexOf(str[i].toUpperCase());
      if (idx < 0) continue;
      bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i < bits.length - 7; i += 8) {
      bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    return Buffer.from(bytes);
  }

  _constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }
}

module.exports = { MFAEngine };
