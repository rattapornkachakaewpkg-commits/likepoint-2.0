// Tenant Service Engine — LikePoint Platform Constitution
// CRM + Campaign + Consent
// Author: AliClaw | Date: 2026-07-07

class TenantService {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.identityService
   * @param {Object} dependencies.notificationService
   * @param {Object} dependencies.auditLog
   */
  constructor({ identityService, notificationService, auditLog, db } = {}) {
    if (!identityService) throw new Error('identityService is required');
    this.identity = identityService;
    this.notify = notificationService;
    this.audit = auditLog || console;

    // Shared stores (inject หรือสร้างใหม่)
    this._crm = db?.crm || new Map();      // member_id → CRM profile
    this._campaigns = db?.campaigns || new Map();
    this._consents = db?.consents || new Map();
  }

  // ============== CRM (Customer Relationship Management) ==============

  /**
   * Get CRM profile for a member
   */
  async getCRMProfile(member_id, tenant_id) {
    const key = `${member_id}:${tenant_id}`;
    if (!this._crm.has(key)) {
      // Create default profile
      const member = await this.identity.getMember(member_id);
      // ไม่ throw แต่ return null ถ้า member ไม่มี
      this._crm.set(key, {
        member_id,
        tenant_id,
        tier: 'BRONZE',
        total_spent: 0,
        total_points_earned: 0,
        total_points_redeemed: 0,
        last_active_at: new Date().toISOString(),
        notes: []
      });
    }
    return this._crm.get(key);
  }

  /**
   * Update CRM profile (e.g., tier upgrade)
   */
  async updateCRMProfile(member_id, tenant_id, updates) {
    const profile = await this.getCRMProfile(member_id, tenant_id);
    if (!profile) throw new Error('PROFILE_NOT_FOUND');

    const allowed = ['tier', 'total_spent', 'total_points_earned', 'total_points_redeemed', 'notes'];
    for (const key of allowed) {
      if (updates[key] !== undefined) profile[key] = updates[key];
    }
    profile.last_active_at = new Date().toISOString();
    this._crm.set(`${member_id}:${tenant_id}`, profile);

    await this.audit.record?.({
      action: 'CRM_UPDATED',
      member_id, tenant_id, updates
    });
    return profile;
  }

  // ============== CAMPAIGN ==============

  /**
   * Create a new campaign
   * @param {Object} campaign
   * @param {string} campaign.tenant_id
   * @param {string} campaign.name
   * @param {string} campaign.type - 'BCT' | 'COUPON' | 'POINT' | 'NOTIFICATION'
   * @param {Date} campaign.start_at
   * @param {Date} campaign.end_at
   * @param {Object} campaign.criteria - Target audience (tier, total_spent, etc.)
   * @param {number} campaign.reward_amount
   */
  async createCampaign({ tenant_id, name, type, start_at, end_at, criteria, reward_amount }) {
    if (!tenant_id || !name || !type) {
      throw new Error('tenant_id, name, type are required');
    }

    const campaign_id = this._generateUUID();
    const campaign = {
      campaign_id,
      tenant_id,
      name,
      type,
      start_at: start_at || new Date().toISOString(),
      end_at,
      criteria: criteria || {},
      reward_amount: reward_amount || 0,
      status: 'DRAFT',
      created_at: new Date().toISOString(),
      enrolled_members: []
    };

    this._campaigns.set(campaign_id, campaign);

    await this.audit.record?.({
      action: 'CAMPAIGN_CREATED',
      campaign_id, tenant_id, name, type
    });

    return campaign;
  }

  /**
   * Activate a campaign
   */
  async activateCampaign(campaign_id) {
    const campaign = this._campaigns.get(campaign_id);
    if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
    if (campaign.status === 'ACTIVE') return campaign;

    campaign.status = 'ACTIVE';
    this._campaigns.set(campaign_id, campaign);

    // Find target members (mock: just enroll all)
    const targetMembers = await this._findTargetMembers(campaign);

    campaign.enrolled_members = targetMembers;
    this._campaigns.set(campaign_id, campaign);

    // Send notifications
    if (this.notify) {
      for (const member of targetMembers) {
        await this.notify.sendTemplated(member.member_id, 'BCT_DISTRIBUTED', {
          amount: campaign.reward_amount, channel: 'SMS'
        });
      }
    }

    await this.audit.record?.({
      action: 'CAMPAIGN_ACTIVATED',
      campaign_id,
      enrolled_count: targetMembers.length
    });

    return campaign;
  }

  /**
   * Find target members based on criteria
   */
  async _findTargetMembers(campaign) {
    const allMembers = this.identity.db?.members || new Map();
    const matches = [];

    for (const member of allMembers.values()) {
      if (member.status !== 'ACTIVE') continue;

      // Check tier criteria
      if (campaign.criteria.tier) {
        const profile = await this.getCRMProfile(member.member_id, campaign.tenant_id);
        if (!profile || profile.tier !== campaign.criteria.tier) continue;
      }

      // Check total_spent criteria
      if (campaign.criteria.min_total_spent) {
        const profile = await this.getCRMProfile(member.member_id, campaign.tenant_id);
        if (!profile || profile.total_spent < campaign.criteria.min_total_spent) continue;
      }

      matches.push(member);
    }

    return matches;
  }

  // ============== CONSENT (PDPA) ==============

  /**
   * Record consent for member (per tenant)
   */
  async recordConsent({ member_id, tenant_id, consent_type, granted }) {
    if (!member_id || !tenant_id || !consent_type) {
      throw new Error('member_id, tenant_id, consent_type are required');
    }

    const key = `${member_id}:${tenant_id}:${consent_type}`;
    const consent = {
      consent_id: this._generateUUID(),
      member_id,
      tenant_id,
      consent_type,
      granted,
      granted_at: granted ? new Date().toISOString() : null,
      revoked_at: !granted ? new Date().toISOString() : null
    };

    this._consents.set(key, consent);

    await this.audit.record?.({
      action: 'TENANT_CONSENT_RECORDED',
      member_id, tenant_id, consent_type, granted
    });

    return consent;
  }

  /**
   * Revoke consent (PDPA right to withdraw)
   */
  async revokeConsent(member_id, tenant_id, consent_type) {
    const key = `${member_id}:${tenant_id}:${consent_type}`;
    const consent = this._consents.get(key);
    if (!consent) throw new Error('CONSENT_NOT_FOUND');
    if (!consent.granted) throw new Error('CONSENT_ALREADY_REVOKED');

    consent.granted = false;
    consent.revoked_at = new Date().toISOString();
    this._consents.set(key, consent);

    await this.audit.record?.({
      action: 'TENANT_CONSENT_REVOKED',
      member_id, tenant_id, consent_type
    });

    return consent;
  }

  /**
   * Check if member has granted consent for specific action
   */
  async hasConsent(member_id, tenant_id, consent_type) {
    const key = `${member_id}:${tenant_id}:${consent_type}`;
    const consent = this._consents.get(key);
    return consent ? consent.granted : false;
  }

  _generateUUID() {
    return 'tnt_' + require('crypto').randomBytes(16).toString('hex');
  }
}

module.exports = { TenantService };
