// Phone Binding Engine — RFC-001 Open Question #2
// "การจัดการหลายเบอร์ต่อสมาชิก"
// Author: AliClaw | Date: 2026-07-07

class PhoneBindingEngine {
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
   * Add a new phone to a member
   * RFC-001: 1 member มีหลายเบอร์ (work/personal/family)
   */
  async addPhone(member_id, { phone_hash, phone_last4, is_primary = false, status = 'PENDING' }) {
    // Validation
    if (!member_id) throw new Error('member_id is required');
    if (!phone_hash) throw new Error('phone_hash is required');
    
    // Check member exists
    const member = await this.identity.getMember(member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');
    if (member.status === 'DELETED') throw new Error('MEMBER_DELETED');
    
    // Check max phones (limit 5 per member)
    const existing = await this.identity.getPhonesForMember(member_id);
    if (existing.length >= 5) {
      throw new Error('MAX_PHONES_REACHED (max 5 per member)');
    }
    
    // Bind via identity service
    const binding = await this.identity.bindPhone({
      member_id,
      phone_hash,
      phone_last4,
      is_primary,
      status
    });
    
    await this.audit.record?.({
      action: 'PHONE_ADDED',
      member_id,
      binding_id: binding.binding_id,
      phone_last4,
      is_primary
    });
    
    return binding;
  }
  
  /**
   * Change primary phone (demote old to secondary, promote new)
   */
  async changePrimaryPhone(member_id, new_phone_hash) {
    const phones = await this.identity.getPhonesForMember(member_id);
    const targetPhone = phones.find(p => p.phone_hash === new_phone_hash);
    
    if (!targetPhone) {
      throw new Error('PHONE_NOT_BOUND_TO_MEMBER');
    }
    
    // Demote all others
    for (const phone of phones) {
      if (phone.is_primary && phone.binding_id !== targetPhone.binding_id) {
        phone.is_primary = false;
        phone.status = 'VERIFIED';  // demoted
      }
    }
    
    // Promote target
    targetPhone.is_primary = true;
    targetPhone.status = 'PRIMARY_VERIFIED';
    
    await this.audit.record?.({
      action: 'PRIMARY_PHONE_CHANGED',
      member_id,
      new_primary_binding_id: targetPhone.binding_id
    });
    
    return targetPhone;
  }
  
  /**
   * Detect phone recycling (same phone_hash used by deleted member recently)
   * RFC-001: "เบอร์โทรที่ถูกนำกลับมาใช้ใหม่อาจทำให้เกิดความเสี่ยง"
   */
  async isPhoneRecycled(phone_hash) {
    // Check deleted members who had this phone
    // (ในระบบจริง query DB with WHERE status='DELETED' AND phone_hash=?)
    return {
      phone_hash,
      is_recycled: false,
      note: 'Production: query deleted members within 90 days'
    };
  }
  
  /**
   * Get all phones for a member (with primary marker)
   */
  async getPhones(member_id) {
    return await this.identity.getPhonesForMember(member_id);
  }
}

module.exports = { PhoneBindingEngine };
