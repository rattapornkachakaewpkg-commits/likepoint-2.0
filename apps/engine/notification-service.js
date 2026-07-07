// Notification Service — PF-15 (Phase E)
// Multi-channel notifications: SMS, Email, Push, Line, Telegram
// Bridges events from PF-7/8/9/10/11/12 → user-facing messages
// Author: AliClaw | Date: 2026-07-07

class NotificationService {
  /**
   * @param {Object} deps
   * @param {Object} deps.notifStore
   * @param {Object} deps.templateStore
   * @param {Object} deps.preferenceStore
   * @param {Object} deps.providers - { sms, email, push, line, telegram } - each is { send: async (to, subject, body) => { provider_id } }
   * @param {Object} deps.auditEngine
   * @param {Object} deps.eventBus
   * @param {Object} deps.logger
   */
  constructor({ notifStore, templateStore, preferenceStore, providers, auditEngine, eventBus, logger } = {}) {
    this.notifs = notifStore || new Map();
    this.templates = templateStore || new Map();
    this.prefs = preferenceStore || new Map();
    this.providers = providers || {
      sms: { send: async () => ({ provider_id: 'mock-sms' }) },
      email: { send: async () => ({ provider_id: 'mock-email' }) },
      push: { send: async () => ({ provider_id: 'mock-push' }) },
      line: { send: async () => ({ provider_id: 'mock-line' }) },
      telegram: { send: async () => ({ provider_id: 'mock-telegram' }) },
    };
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.logger = logger || console;
    this._idSeq = 0;
  }

  // ============================================================
  // 1. createTemplate() — define a reusable template
  // ============================================================
  async createTemplate({ template_id, name, channel, subject, body, variables = [], actor = 'admin' }) {
    if (!template_id || !name || !channel || !body) {
      throw new Error('template_id, name, channel, body are required');
    }
    if (!['sms', 'email', 'push', 'line', 'telegram'].includes(channel)) {
      throw new Error(`Invalid channel: ${channel}`);
    }

    const template = {
      template_id,
      name,
      channel,
      subject: subject || null,
      body,
      variables, // e.g., ['member_name', 'amount', 'merchant_name']
      status: 'active',
      created_at: new Date().toISOString(),
    };
    this.templates.set(template_id, template);

    await this.audit.log({
      event_type: 'NOTIF_TEMPLATE_CREATED', actor,
      resource_type: 'notification_template', resource_id: template_id,
      action: 'CREATE',
      metadata: { name, channel, variable_count: variables.length },
    });
    return template;
  }

  // ============================================================
  // 2. send() — send a single notification
  // ============================================================
  async send({ template_id, recipient, variables = {}, idempotency_key = null, actor = 'system' }) {
    if (!template_id || !recipient) {
      throw new Error('template_id, recipient are required');
    }
    const template = this.templates.get(template_id);
    if (!template) throw new Error(`Template not found: ${template_id}`);
    if (template.status !== 'active') throw new Error(`Template is ${template.status}`);

    // Idempotency
    if (idempotency_key) {
      const existing = Array.from(this.notifs.values()).find(
        (n) => n.idempotency_key === idempotency_key
      );
      if (existing) return existing;
    }

    // Check user preferences
    const pref = this.prefs.get(recipient.member_id);
    if (pref && pref.opt_out && pref.opt_out.includes(template_id)) {
      this.logger.info?.('Notification skipped (opt-out)', { member: recipient.member_id, template_id });
      return { status: 'OPTED_OUT', notification_id: null };
    }
    if (pref && pref.channels && !pref.channels.includes(template.channel)) {
      this.logger.info?.('Notification skipped (channel disabled)', { member: recipient.member_id, channel: template.channel });
      return { status: 'CHANNEL_DISABLED', notification_id: null };
    }

    // Render template
    const rendered = this._render(template, variables);

    // Send via provider
    const provider = this.providers[template.channel];
    let result;
    try {
      result = await provider.send({
        to: recipient[template.channel] || recipient.address || recipient.member_id,
        subject: rendered.subject,
        body: rendered.body,
        variables,
        template_id,
      });
    } catch (e) {
      this.logger.error?.('Notification send failed', { template_id, error: e.message });
      return { status: 'FAILED', error: e.message, notification_id: null };
    }

    const notification_id = `NOTIF-${Date.now()}-${++this._idSeq}`;
    const notification = {
      notification_id,
      template_id,
      template_name: template.name,
      channel: template.channel,
      recipient_member_id: recipient.member_id,
      to: recipient[template.channel] || recipient.address || recipient.member_id,
      subject: rendered.subject,
      body: rendered.body,
      variables,
      provider_id: result.provider_id,
      status: 'sent',
      idempotency_key,
      sent_at: new Date().toISOString(),
      read_at: null,
      actor,
    };
    this.notifs.set(notification_id, notification);

    await this.bus.publish('notification.sent', {
      notification_id, template_id, recipient: recipient.member_id, channel: template.channel,
    });
    await this.audit.log({
      event_type: 'NOTIFICATION_SENT', actor,
      resource_type: 'notification', resource_id: notification_id,
      member_id: recipient.member_id,
      action: 'CREATE',
      metadata: { template_id, channel: template.channel, provider_id: result.provider_id },
    });

    return notification;
  }

  // ============================================================
  // 3. sendBulk() — send to many recipients
  // ============================================================
  async sendBulk({ template_id, recipients, variables = {}, actor = 'system' }) {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new Error('recipients must be a non-empty array');
    }
    const results = { sent: 0, opted_out: 0, failed: 0, items: [] };
    for (const r of recipients) {
      try {
        const result = await this.send({ template_id, recipient: r, variables, actor });
        if (result.status === 'OPTED_OUT' || result.status === 'CHANNEL_DISABLED') {
          results.opted_out++;
        } else if (result.status === 'FAILED') {
          results.failed++;
        } else {
          results.sent++;
        }
        results.items.push(result);
      } catch (e) {
        results.failed++;
        results.items.push({ status: 'FAILED', error: e.message, recipient: r.member_id });
      }
    }
    return results;
  }

  // ============================================================
  // 4. setPreference() — user opt-in/opt-out per template + channel
  // ============================================================
  async setPreference({ member_id, opt_out = [], channels = ['sms', 'email', 'push', 'line', 'telegram'], quiet_hours = null }) {
    this.prefs.set(member_id, {
      member_id,
      opt_out, // array of template_ids to skip
      channels, // allowed channels
      quiet_hours, // { start: '22:00', end: '08:00' } — skip if not urgent
      updated_at: new Date().toISOString(),
    });
    return this.prefs.get(member_id);
  }

  // ============================================================
  // 5. markRead() — for in-app notifications
  // ============================================================
  async markRead({ notification_id, member_id }) {
    const notif = this.notifs.get(notification_id);
    if (!notif) throw new Error(`Notification not found: ${notification_id}`);
    if (notif.recipient_member_id !== member_id) {
      throw new Error('Cannot mark another user\'s notification as read');
    }
    notif.read_at = new Date().toISOString();
    notif.status = 'read';
    return notif;
  }

  // ============================================================
  // 6. listForMember() — get a member's notification history
  // ============================================================
  async listForMember({ member_id, status, channel, limit = 50 }) {
    let all = Array.from(this.notifs.values()).filter((n) => n.recipient_member_id === member_id);
    if (status) all = all.filter((n) => n.status === status);
    if (channel) all = all.filter((n) => n.channel === channel);
    all.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 7. getStats() — analytics
  // ============================================================
  async getStats({ since, channel } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    let all = Array.from(this.notifs.values());
    if (channel) all = all.filter((n) => n.channel === channel);
    const recent = all.filter((n) => new Date(n.sent_at).getTime() >= sinceMs);
    return {
      total: all.length,
      recent: recent.length,
      sent: recent.filter((n) => n.status === 'sent' || n.status === 'read').length,
      read: recent.filter((n) => n.status === 'read').length,
      failed: recent.filter((n) => n.status === 'FAILED').length,
      read_rate: recent.length > 0 ? ((recent.filter((n) => n.status === 'read').length / recent.length) * 100).toFixed(1) : 0,
      by_channel: recent.reduce((acc, n) => {
        acc[n.channel] = (acc[n.channel] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  // ============================================================
  // private
  // ============================================================
  _render(template, variables) {
    let body = template.body;
    let subject = template.subject || '';
    for (const [key, value] of Object.entries(variables)) {
      const re = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      body = body.replace(re, value);
      subject = subject.replace(re, value);
    }
    return { subject, body };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NotificationService };
}
if (typeof window !== 'undefined') {
  window.NotificationService = NotificationService;
}
