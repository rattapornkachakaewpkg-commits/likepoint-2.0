// KYC Integration Engine — RFC-001 Open Question #9
// "รองรับ KYC ภายหลัง"
// Author: AliClaw | Date: 2026-07-07

class KYCEngine {
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
   * Upgrade KYC level
   * RFC-001: "รองรับ KYC ภายหลัง"
   * Levels:
   *   LEVEL_0: No verification
   *   LEVEL_1: Phone verified (default)
   *   LEVEL_2: ID + selfie verified (full KYC)
   */
  async upgradeKYC(member_id, { target_level, documents }) {
    const member = await this.identity.getMember(member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');

    const currentLevel = member.kyc_level;
    const validLevels = ['LEVEL_0', 'LEVEL_1', 'LEVEL_2'];

    if (!validLevels.includes(target_level)) {
      throw new Error('INVALID_KYC_LEVEL');
    }

    if (target_level === 'LEVEL_2' && !documents) {
      throw new Error('LEVEL_2_REQUIRES_DOCUMENTS');
    }

    // Auto-approve for LEVEL_1 (phone already verified)
    if (target_level === 'LEVEL_1') {
      await this.identity.updateMember(member_id, { kyc_level: 'LEVEL_1' });
      await this.audit.record?.({
        action: 'KYC_UPGRADED',
        member_id,
        from: currentLevel,
        to: 'LEVEL_1'
      });
      return { approved: true, level: 'LEVEL_1' };
    }

    // LEVEL_2: Manual review (store documents for compliance)
    if (target_level === 'LEVEL_2') {
      // In production: store encrypted documents, notify reviewer
      await this.audit.record?.({
        action: 'KYC_REVIEW_REQUESTED',
        member_id,
        documents_received: Object.keys(documents || {}).length
      });
      return { approved: false, status: 'PENDING_REVIEW', level: 'LEVEL_2' };
    }

    throw new Error('NOT_IMPLEMENTED');
  }

  /**
   * Check if member is allowed to perform action based on KYC level
   * Use case: high-value transactions require LEVEL_2
   */
  checkKYCGate(member, requiredLevel) {
    const levels = { 'LEVEL_0': 0, 'LEVEL_1': 1, 'LEVEL_2': 2 };
    const memberLevel = levels[member.kyc_level || 'LEVEL_0'];
    const required = levels[requiredLevel];
    return {
      allowed: memberLevel >= required,
      current: member.kyc_level,
      required: requiredLevel
    };
  }
}

module.exports = { KYCEngine };
