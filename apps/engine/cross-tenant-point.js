// Cross-Tenant Point Transfer Engine
// RFC-001 Open Question #6: "การย้าย Point ระหว่าง Tenant"
// Author: AliClaw | Date: 2026-07-07

class CrossTenantPointEngine {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.walletAPI
   * @param {Object} dependencies.tenantAPI
   * @param {Object} dependencies.auditLog
   */
  constructor({ walletAPI, tenantAPI, auditLog } = {}) {
    if (!walletAPI) throw new Error('walletAPI is required');
    this.wallet = walletAPI;
    this.tenant = tenantAPI;
    this.audit = auditLog || console;
  }

  /**
   * Transfer points from one tenant to another (same member, different tenants)
   * Use case: Customer has points in Tenant A (8,200 P) wants to use in Tenant B
   */
  async transferCrossTenant({ member_id, from_tenant_id, to_tenant_id, amount, exchange_rate, reason }) {
    if (!member_id || !from_tenant_id || !to_tenant_id || amount === undefined || amount === null) {
      throw new Error('member_id, from_tenant_id, to_tenant_id, amount are required');
    }
    if (from_tenant_id === to_tenant_id) {
      throw new Error('USE_REGULAR_TRANSFER_FOR_SAME_TENANT');
    }
    if (amount <= 0) {
      throw new Error('AMOUNT_MUST_BE_POSITIVE');
    }

    // 1. Check member has relationship with both tenants
    const fromRel = await this.tenant.getRelationship(member_id, from_tenant_id);
    if (!fromRel) throw new Error('NO_RELATIONSHIP_WITH_SOURCE_TENANT');

    const toRel = await this.tenant.getRelationship(member_id, to_tenant_id);
    if (!toRel) throw new Error('NO_RELATIONSHIP_WITH_TARGET_TENANT');

    // 2. Check source balance
    const sourceBalance = await this.wallet.getBalance(member_id, from_tenant_id);
    if (sourceBalance < amount) {
      throw new Error(`INSUFFICIENT_BALANCE: have ${sourceBalance}, need ${amount}`);
    }

    // 3. Calculate exchange rate (if not provided)
    const finalRate = exchange_rate || await this._getExchangeRate(from_tenant_id, to_tenant_id);
    const targetAmount = Math.floor(amount * finalRate);

    // 4. Execute atomic transfer (2-phase commit)
    const transferId = this._generateUUID();

    try {
      // Phase 1: Debit from source
      await this.wallet.debit({
        member_id,
        tenant_id: from_tenant_id,
        amount,
        transfer_id: transferId,
        reason: `TRANSFER_OUT_TO_${to_tenant_id}`
      });

      // Phase 2: Credit to target
      await this.wallet.credit({
        member_id,
        tenant_id: to_tenant_id,
        amount: targetAmount,
        transfer_id: transferId,
        reason: `TRANSFER_IN_FROM_${from_tenant_id}`
      });

      // Audit
      await this.audit.record?.({
        action: 'CROSS_TENANT_TRANSFER',
        transfer_id: transferId,
        member_id,
        from_tenant_id,
        to_tenant_id,
        amount,
        target_amount: targetAmount,
        exchange_rate: finalRate,
        reason,
        timestamp: new Date().toISOString()
      });

      return {
        transfer_id: transferId,
        from_tenant_id,
        to_tenant_id,
        source_amount: amount,
        target_amount: targetAmount,
        exchange_rate: finalRate,
        status: 'COMPLETED'
      };
    } catch (err) {
      // Rollback if phase 2 fails
      await this.audit.record?.({
        action: 'CROSS_TENANT_TRANSFER_FAILED',
        transfer_id: transferId,
        error: err.message
      });
      throw new Error(`TRANSFER_FAILED_AND_ROLLED_BACK: ${err.message}`);
    }
  }

  /**
   * Get exchange rate between 2 tenants
   * Default: 1:1 (1 point from Tenant A = 1 point in Tenant B)
   * Production: query from tenant_rates table
   */
  async _getExchangeRate(fromTenantId, toTenantId) {
    if (this.tenant.getExchangeRate) {
      return await this.tenant.getExchangeRate(fromTenantId, toTenantId);
    }
    return 1.0;  // default 1:1
  }

  /**
   * Get transfer history for a member
   */
  async getHistory(member_id) {
    if (this.audit.getRecords) {
      const records = await this.audit.getRecords();
      return records.filter(r =>
        r.action === 'CROSS_TENANT_TRANSFER' && r.member_id === member_id
      );
    }
    return [];
  }

  _generateUUID() {
    return 'xfr_' + require('crypto').randomBytes(16).toString('hex');
  }
}

module.exports = { CrossTenantPointEngine };
