// Identity Service — Platform Member (RFC-001)
// Generates UUID เมื่อสมัครครั้งแรก + จัดการ Member lifecycle
// Author: AliClaw | Date: 2026-07-07

const crypto = require('crypto');

// =================== TYPES (JSDoc) ===================
/**
 * @typedef {Object} Member
 * @property {string} member_id        - UUID (canonical identity)
 * @property {string} display_name
 * @property {string} status           - 'ACTIVE' | 'SUSPENDED' | 'DELETED'
 * @property {string} trust_score      - '0-100'
 * @property {string} kyc_level        - 'LEVEL_0' | 'LEVEL_1' | 'LEVEL_2'
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} [deleted_at]
 */

/**
 * @typedef {Object} PhoneBinding
 * @property {string} binding_id       - UUID
 * @property {string} member_id        - FK to Member
 * @property {string} phone_hash       - SHA256 hash (PDPA)
 * @property {string} phone_last4      - "5678" (สำหรับ display)
 * @property {string} status           - 'PRIMARY' | 'SECONDARY' | 'VERIFIED' | 'PENDING'
 * @property {boolean} is_primary
 * @property {string} created_at
 * @property {string} verified_at
 */

/**
 * @typedef {Object} DeviceBinding
 * @property {string} device_id
 * @property {string} member_id
 * @property {string} device_fingerprint
 * @property {string} platform          - 'ios' | 'android' | 'web'
 * @property {string} last_seen_at
 */

/**
 * @typedef {Object} LoginHistory
 * @property {string} member_id
 * @property {string} login_at
 * @property {string} ip_address
 * @property {string} user_agent
 * @property {string} result            - 'SUCCESS' | 'FAILED'
 */

/**
 * @typedef {Object} Consent
 * @property {string} member_id
 * @property {string} consent_type      - 'MARKETING' | 'DATA_PROCESSING' | 'THIRD_PARTY_SHARING'
 * @property {boolean} granted
 * @property {string} granted_at
 * @property {string} [revoked_at]
 */

// =================== IDENTITY SERVICE ===================

class IdentityService {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.db - In-memory DB (mock) หรือ Prisma client
   * @param {Object} [dependencies.auditLog]
   */
  constructor({ db, auditLog } = {}) {
    if (!db) throw new Error('db is required');
    this.db = db;
    this.audit = auditLog || console;
  }

  // ============== MEMBER LIFECYCLE ==============

  /**
   * Create new Member — generates UUID เมื่อสมัครครั้งแรก
   * RFC-001 Decision: "Platform จะสร้าง Member ID แบบ UUID ตั้งแต่การสมัครครั้งแรก"
   * @param {Object} params
   * @param {string} params.display_name
   * @param {string} [params.phone_hash]
   * @param {string} [params.phone_last4]
   * @returns {Promise<{member: Member, phone_binding: PhoneBinding}>}
   */
  async createMember({ display_name, phone_hash, phone_last4 }) {
    if (!display_name) throw new Error('display_name is required');
    
    // 1. Generate UUID
    const member_id = this._generateUUID();
    
    // 2. Create Member
    const member = {
      member_id,
      display_name,
      status: 'ACTIVE',
      trust_score: '50',  // default
      kyc_level: 'LEVEL_0',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    this.db.members.set(member_id, member);
    
    // 3. Create Phone Binding (if provided)
    let phone_binding = null;
    if (phone_hash) {
      phone_binding = await this.bindPhone({
        member_id,
        phone_hash,
        phone_last4,
        is_primary: true,
        status: 'VERIFIED'  // assume verified at signup
      });
    }
    
    // 4. Audit
    await this.audit.record?.({
      action: 'MEMBER_CREATED',
      member_id,
      display_name,
      timestamp: new Date().toISOString()
    });
    
    this._log('info', `✅ Member created: ${member_id} (${display_name})`);
    
    return { member, phone_binding };
  }

  /**
   * Get Member by member_id
   */
  async getMember(member_id) {
    return this.db.members.get(member_id) || null;
  }

  /**
   * Get Member by phone_hash
   */
  async getMemberByPhone(phone_hash) {
    // Find all bindings for this phone
    const binding = Array.from(this.db.phone_bindings.values())
      .find(b => b.phone_hash === phone_hash);
    if (!binding) return null;
    return this.db.members.get(binding.member_id) || null;
  }

  /**
   * Update Member profile
   */
  async updateMember(member_id, updates) {
    const member = this.db.members.get(member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');
    if (member.status === 'DELETED') throw new Error('MEMBER_DELETED');
    
    // Only allow certain fields
    const allowed = ['display_name', 'kyc_level', 'status'];
    const safeUpdates = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) safeUpdates[key] = updates[key];
    }
    
    Object.assign(member, safeUpdates, { updated_at: new Date().toISOString() });
    this.db.members.set(member_id, member);
    
    await this.audit.record?.({
      action: 'MEMBER_UPDATED',
      member_id,
      updates: safeUpdates,
      timestamp: new Date().toISOString()
    });
    
    return member;
  }

  /**
   * Soft delete Member
   */
  async deleteMember(member_id) {
    const member = this.db.members.get(member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');
    
    member.status = 'DELETED';
    member.deleted_at = new Date().toISOString();
    member.updated_at = new Date().toISOString();
    this.db.members.set(member_id, member);
    
    await this.audit.record?.({
      action: 'MEMBER_DELETED',
      member_id,
      timestamp: new Date().toISOString()
    });
    
    return member;
  }

  // ============== PHONE BINDINGS (RFC-001 Open Question #2) ==============

  /**
   * Bind a phone to Member
   * RFC-001 Open Question #2: "การจัดการหลายเบอร์ต่อสมาชิก"
   */
  async bindPhone({ member_id, phone_hash, phone_last4, is_primary = false, status = 'PENDING' }) {
    if (!member_id || !phone_hash) {
      throw new Error('member_id and phone_hash are required');
    }
    
    // Check if member exists
    const member = this.db.members.get(member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');
    
    // Check if phone already bound to another member (no duplicate identity)
    const existingBinding = Array.from(this.db.phone_bindings.values())
      .find(b => b.phone_hash === phone_hash);
    if (existingBinding && existingBinding.member_id !== member_id) {
      throw new Error('PHONE_ALREADY_BOUND_TO_ANOTHER_MEMBER');
    }
    
    // If setting as primary, demote existing primary
    if (is_primary) {
      for (const b of this.db.phone_bindings.values()) {
        if (b.member_id === member_id && b.is_primary) {
          b.is_primary = false;
          b.status = b.status.replace('PRIMARY', 'SECONDARY');
        }
      }
    }
    
    // Create binding
    const binding_id = this._generateUUID();
    const binding = {
      binding_id,
      member_id,
      phone_hash,
      phone_last4: phone_last4 || phone_hash.slice(-4),
      status,
      is_primary,
      created_at: new Date().toISOString(),
      verified_at: status === 'VERIFIED' ? new Date().toISOString() : null
    };
    
    this.db.phone_bindings.set(binding_id, binding);
    
    await this.audit.record?.({
      action: 'PHONE_BOUND',
      binding_id,
      member_id,
      phone_last4,
      is_primary,
      timestamp: new Date().toISOString()
    });
    
    return binding;
  }

  /**
   * Get all phones for a Member
   */
  async getPhonesForMember(member_id) {
    return Array.from(this.db.phone_bindings.values())
      .filter(b => b.member_id === member_id);
  }

  /**
   * Remove phone binding
   */
  async unbindPhone(binding_id) {
    const binding = this.db.phone_bindings.get(binding_id);
    if (!binding) throw new Error('BINDING_NOT_FOUND');
    if (binding.is_primary) throw new Error('CANNOT_REMOVE_PRIMARY_PHONE');
    
    this.db.phone_bindings.delete(binding_id);
    
    await this.audit.record?.({
      action: 'PHONE_UNBOUND',
      binding_id,
      member_id: binding.member_id,
      timestamp: new Date().toISOString()
    });
    
    return { success: true };
  }

  // ============== CONSENT (PDPA) ==============

  async recordConsent({ member_id, consent_type, granted }) {
    if (!member_id || !consent_type) {
      throw new Error('member_id and consent_type are required');
    }
    
    const consent_id = this._generateUUID();
    const consent = {
      consent_id,
      member_id,
      consent_type,
      granted,
      granted_at: granted ? new Date().toISOString() : null,
      revoked_at: !granted ? new Date().toISOString() : null
    };
    
    this.db.consents.set(consent_id, consent);
    
    await this.audit.record?.({
      action: 'CONSENT_RECORDED',
      member_id,
      consent_type,
      granted,
      timestamp: new Date().toISOString()
    });
    
    return consent;
  }

  async revokeConsent(consent_id) {
    const consent = this.db.consents.get(consent_id);
    if (!consent) throw new Error('CONSENT_NOT_FOUND');
    if (!consent.granted) throw new Error('CONSENT_ALREADY_REVOKED');
    
    consent.granted = false;
    consent.revoked_at = new Date().toISOString();
    this.db.consents.set(consent_id, consent);
    
    return consent;
  }

  // ============== HELPERS ==============
  _generateUUID() {
    return 'usr_' + crypto.randomBytes(16).toString('hex');
  }
  
  _log(level, msg) {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] [Identity] ${msg}`);
  }
}

module.exports = { IdentityService };
