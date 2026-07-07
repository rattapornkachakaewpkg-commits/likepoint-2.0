// Notification Service — RFC-001 Open Question #11
// Multi-channel: SMS, Email, Push
// Author: AliClaw | Date: 2026-07-07

class NotificationService {
  constructor() {
    this.sent = [];
  }

  /**
   * Send notification via SMS, Email, or Push
   */
  async send(member_id, { type, channel, message, metadata }) {
    if (!['SMS', 'EMAIL', 'PUSH'].includes(channel)) {
      throw new Error('INVALID_CHANNEL');
    }

    // Mock: log only
    const record = {
      notification_id: this._generateUUID(),
      member_id,
      type,
      channel,
      message,
      metadata,
      sent_at: new Date().toISOString(),
      status: 'SENT'
    };
    this.sent.push(record);
    console.log(`[${channel}] to ${member_id}: ${message}`);
    return record;
  }

  /**
   * Send templated notification
   * Templates: BCT_DISTRIBUTED, WALLET_REBOUND, PHONE_CHANGED, SUSPICIOUS_LOGIN
   */
  async sendTemplated(member_id, template, variables) {
    const templates = {
      BCT_DISTRIBUTED: `คุณได้รับ ${variables.amount} BCT เรียบร้อยแล้ว`,
      WALLET_REBOUND: `Wallet ของคุณถูก rebind เข้ากับเบอร์ใหม่เรียบร้อย`,
      PHONE_CHANGED: `เบอร์โทรของคุณถูกเปลี่ยนเรียบร้อย หากไม่ใช่คุณ กรุณาติดต่อ admin`,
      SUSPICIOUS_LOGIN: `ตรวจพบการเข้าสู่ระบบจากอุปกรณ์ใหม่ หากไม่ใช่คุณ กรุณาเปลี่ยนรหัสผ่าน`,
      MFA_CODE: `รหัส MFA ของคุณคือ ${variables.code} (ห้ามแชร์กับผู้อื่น)`
    };

    const message = templates[template];
    if (!message) throw new Error('UNKNOWN_TEMPLATE');

    return await this.send(member_id, { type: template, channel: variables.channel || 'SMS', message });
  }

  _generateUUID() {
    return 'ntf_' + require('crypto').randomBytes(16).toString('hex');
  }
}

module.exports = { NotificationService };
