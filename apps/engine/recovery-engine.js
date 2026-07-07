// Recovery Flow — PF-19 (Phase E)
// Account recovery: phone OTP, email link, security questions, lockout
// Author: AliClaw | Date: 2026-07-07

class RecoveryEngine {
  constructor({ requestStore, memberStore, tokenStore, auditEngine, eventBus, notifier, logger } = {}) {
    this.requests = requestStore || new Map();
    this.members = memberStore || new Map();
    this.tokens = tokenStore || new Map();
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.notifier = notifier || { send: async () => ({ status: 'mock' }) };
    this.logger = logger || console;
    this._idSeq = 0;
    this.LOCKOUT = { MAX_ATTEMPTS: 5, LOCKOUT_MS: 15 * 60 * 1000 }; // 5 attempts, 15min
  }

  // ============================================================
  // 1. requestOTP() — request OTP via phone or email
  // ============================================================
  async requestOTP({ member_id, method, contact, ip_address = null, actor = 'user' }) {
    if (!member_id || !method || !contact) throw new Error('member_id, method, contact required');
    if (!['phone', 'email'].includes(method)) throw new Error(`Invalid method: ${method}`);

    const member = this.members.get(member_id);
    if (!member) throw new Error('Member not found');

    // Check lockout
    const lock = this._checkLockout(member_id);
    if (lock.locked) throw new Error(`Locked. Try again in ${lock.remaining_min} min`);

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const request_id = `REC-${Date.now()}-${++this._idSeq}`;
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10min

    const request = {
      request_id, member_id, method, contact,
      otp_hash: this._hash(otp), // store hash, not OTP
      expires_at,
      attempts: 0,
      verified: false,
      ip_address,
      created_at: new Date().toISOString(),
    };
    this.requests.set(request_id, request);

    // Send OTP
    await this.notifier.send({
      template_id: method === 'phone' ? 'recovery-otp-sms' : 'recovery-otp-email',
      recipient: { member_id, [method]: contact },
      variables: { otp, expires_in_min: '10' },
    });

    await this.audit.log({
      event_type: 'RECOVERY_OTP_REQUESTED', actor,
      resource_type: 'recovery', resource_id: request_id,
      member_id, action: 'CREATE',
      metadata: { method, contact: contact.replace(/(.{3}).+(.{2})/, '$1***$2'), ip_address },
    });
    return { request_id, expires_at, message: `OTP sent to ${method}` };
  }

  // ============================================================
  // 2. verifyOTP() — verify OTP
  // ============================================================
  async verifyOTP({ request_id, otp, actor = 'user' }) {
    const request = this.requests.get(request_id);
    if (!request) throw new Error('Invalid request');
    if (request.verified) throw new Error('Already verified');
    if (Date.now() > new Date(request.expires_at).getTime()) {
      throw new Error('OTP expired');
    }
    request.attempts++;
    if (this._hash(otp) !== request.otp_hash) {
      // Increment failed attempts on member
      const member = this.members.get(request.member_id);
      if (member) {
        member.failed_recovery_attempts = (member.failed_recovery_attempts || 0) + 1;
        member.last_recovery_attempt_at = new Date().toISOString();
        if (member.failed_recovery_attempts >= this.LOCKOUT.MAX_ATTEMPTS) {
          member.locked_until = new Date(Date.now() + this.LOCKOUT.LOCKOUT_MS).toISOString();
        }
      }
      await this.audit.log({
        event_type: 'RECOVERY_OTP_FAILED', actor,
        resource_type: 'recovery', resource_id: request_id,
        member_id: request.member_id, action: 'UPDATE',
        metadata: { attempts: request.attempts },
      });
      throw new Error(`Invalid OTP. ${this.LOCKOUT.MAX_ATTEMPTS - (member?.failed_recovery_attempts || 0)} attempts left`);
    }
    request.verified = true;
    request.verified_at = new Date().toISOString();
    // Reset failed attempts on success
    const member = this.members.get(request.member_id);
    if (member) {
      member.failed_recovery_attempts = 0;
      member.locked_until = null;
    }
    await this.audit.log({
      event_type: 'RECOVERY_OTP_VERIFIED', actor,
      resource_type: 'recovery', resource_id: request_id,
      member_id: request.member_id, action: 'UPDATE',
    });
    return { verified: true, member_id: request.member_id, recovery_token: this._generateRecoveryToken(request.member_id) };
  }

  // ============================================================
  // 3. requestSecurityQuestion() — get security question
  // ============================================================
  async setSecurityQuestions({ member_id, questions, actor = 'user' }) {
    if (!Array.isArray(questions) || questions.length < 2) {
      throw new Error('At least 2 security questions required');
    }
    const member = this.members.get(member_id);
    if (!member) throw new Error('Member not found');
    member.security_questions = questions.map((q) => ({
      question: q.question,
      answer_hash: this._hash(q.answer.toLowerCase().trim()),
    }));
    await this.audit.log({
      event_type: 'SECURITY_QUESTIONS_SET', actor,
      resource_type: 'member', resource_id: member_id,
      action: 'CREATE', metadata: { count: questions.length },
    });
    return { count: questions.length };
  }

  async verifySecurityQuestion({ member_id, answers, actor = 'user' }) {
    const member = this.members.get(member_id);
    if (!member || !member.security_questions) throw new Error('No security questions set');
    let correct = 0;
    for (const ans of answers) {
      const q = member.security_questions.find((x) => x.question === ans.question);
      if (q && q.answer_hash === this._hash(ans.answer.toLowerCase().trim())) correct++;
    }
    if (correct < 2) throw new Error(`Only ${correct}/2 correct`);
    return { verified: true, recovery_token: this._generateRecoveryToken(member_id) };
  }

  // ============================================================
  // 4. resetPassword() — set new password (requires recovery_token)
  // ============================================================
  async resetPassword({ recovery_token, new_password_hash, actor = 'user' }) {
    if (!recovery_token || !new_password_hash) throw new Error('recovery_token, new_password_hash required');
    const member_id = this._verifyRecoveryToken(recovery_token);
    if (!member_id) throw new Error('Invalid or expired recovery token');
    if (new_password_hash.length < 8) throw new Error('Password too short (min 8)');
    const member = this.members.get(member_id);
    if (!member) throw new Error('Member not found');
    member.password_hash = new_password_hash;
    member.password_reset_at = new Date().toISOString();
    // Invalidate all sessions (would call session-guard)
    member.invalidate_sessions = true;
    // Remove recovery token
    this.tokens.delete(recovery_token);
    await this.audit.log({
      event_type: 'PASSWORD_RESET', actor,
      resource_type: 'member', resource_id: member_id,
      action: 'UPDATE', metadata: { method: 'recovery' },
    });
    await this.bus.publish('password.reset', { member_id });
    await this.notifier.send({
      template_id: 'password-reset-success',
      recipient: { member_id },
    });
    return { member_id, sessions_invalidated: true };
  }

  // ============================================================
  // 5. emailLinkRecovery() — magic link via email
  // ============================================================
  async requestEmailLink({ member_id, email, ip_address = null }) {
    if (!member_id || !email) throw new Error('member_id, email required');
    const token = this._generateRecoveryToken(member_id, 'email-link');
    const link = `https://likepoint.io/recover?token=${token}`;
    this.tokens.set(token, { member_id, type: 'email-link', expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
    await this.notifier.send({
      template_id: 'recovery-link-email',
      recipient: { member_id, email },
      variables: { link, expires_in_min: '30' },
    });
    await this.audit.log({
      event_type: 'RECOVERY_LINK_REQUESTED', actor: 'user',
      resource_type: 'recovery', resource_id: token,
      member_id, action: 'CREATE', metadata: { ip_address },
    });
    return { link_sent: true, expires_in_min: 30 };
  }

  // ============================================================
  // 6. lockAccount() / unlockAccount()
  // ============================================================
  async lockAccount({ member_id, reason, actor = 'admin' }) {
    const member = this.members.get(member_id);
    if (!member) throw new Error('Member not found');
    member.locked_until = new Date(Date.now() + this.LOCKOUT.LOCKOUT_MS).toISOString();
    member.lock_reason = reason;
    await this.audit.log({
      event_type: 'ACCOUNT_LOCKED', actor,
      resource_type: 'member', resource_id: member_id,
      action: 'UPDATE', metadata: { reason },
    });
    return { locked_until: member.locked_until };
  }

  // ============================================================
  // 7. getRecoveryStatus()
  // ============================================================
  async getRecoveryStatus({ member_id }) {
    const member = this.members.get(member_id);
    if (!member) return { has_member: false };
    const lock = this._checkLockout(member_id);
    return {
      has_member: true,
      has_security_questions: !!(member.security_questions?.length),
      failed_attempts: member.failed_recovery_attempts || 0,
      locked: lock.locked,
      locked_until: member.locked_until || null,
      remaining_min: lock.remaining_min,
    };
  }

  // ============================================================
  // private
  // ============================================================
  _checkLockout(member_id) {
    const member = this.members.get(member_id);
    if (!member?.locked_until) return { locked: false, remaining_min: 0 };
    const remaining = new Date(member.locked_until).getTime() - Date.now();
    if (remaining > 0) {
      return { locked: true, remaining_min: Math.ceil(remaining / 60000) };
    }
    return { locked: false, remaining_min: 0 };
  }

  _hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `h${Math.abs(h).toString(16)}`;
  }

  _generateRecoveryToken(member_id, type = 'otp') {
    const token = `RTOK-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.tokens.set(token, { member_id, type, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    return token;
  }

  _verifyRecoveryToken(token) {
    const data = this.tokens.get(token);
    if (!data || data.type === 'email-link') return null; // email links need different flow
    if (Date.now() > new Date(data.expires_at).getTime()) {
      this.tokens.delete(token);
      return null;
    }
    return data.member_id;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RecoveryEngine };
}
if (typeof window !== 'undefined') {
  window.RecoveryEngine = RecoveryEngine;
}
