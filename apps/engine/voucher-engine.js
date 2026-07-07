// Voucher Engine — PF-12 (Phase E)
// Coupons/vouchers with expiry + discount — merchant-issued promo tool
// Based on Likepoint meeting 16/12/2022: "Gift Voucher (ส่งให้มีระยะเวลา จำนวนPoint ที่กำหนด)"
// Author: AliClaw | Date: 2026-07-07

class VoucherEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.voucherStore
   * @param {Object} deps.redemptionStore
   * @param {Object} deps.merchantService
   * @param {Object} deps.memberService
   * @param {Object} deps.tokenEngine
   * @param {Object} deps.auditEngine
   * @param {Object} deps.eventBus
   */
  constructor({ voucherStore, redemptionStore, merchantService, memberService, tokenEngine, auditEngine, eventBus } = {}) {
    this.vouchers = voucherStore || new Map();
    this.redemptions = redemptionStore || new Map();
    this.merchants = merchantService || { get: async () => null };
    this.members = memberService || { get: async () => null };
    this.tokens = tokenEngine || { credit: async () => ({ txn_id: 'mock' }), debit: async () => ({ txn_id: 'mock' }) };
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this._idSeq = 0;
  }

  // ============================================================
  // 1. createVoucher() — merchant issues a new voucher
  // ============================================================
  async createVoucher({ merchant_id, name, code = null, discount_type, discount_value, min_purchase = 0, max_discount = null, total_quantity = 1, per_user_limit = 1, valid_from, valid_until, applicable_token_id = null, applicable_products = null, actor = 'merchant' }) {
    if (!merchant_id || !name || !discount_type || discount_value === undefined || !valid_from || !valid_until) {
      throw new Error('merchant_id, name, discount_type, discount_value, valid_from, valid_until are required');
    }
    if (!['percentage', 'fixed'].includes(discount_type)) {
      throw new Error(`Invalid discount_type: ${discount_type}`);
    }
    if (typeof discount_value !== 'number' || discount_value <= 0) {
      throw new Error('discount_value must be positive number');
    }
    if (discount_type === 'percentage' && (discount_value < 0 || discount_value > 100)) {
      throw new Error('percentage discount must be 0-100');
    }
    if (new Date(valid_until) <= new Date(valid_from)) {
      throw new Error('valid_until must be after valid_from');
    }

    const merchant = await this.merchants.get(merchant_id);
    if (!merchant) throw new Error(`Merchant not found: ${merchant_id}`);
    if (merchant.status !== 'active') throw new Error(`Merchant is ${merchant.status}`);

    const voucher_id = `VCH-${Date.now()}-${++this._idSeq}`;
    const finalCode = code || this._generateCode();

    const voucher = {
      voucher_id,
      code: finalCode,
      merchant_id,
      name,
      discount_type,
      discount_value,
      min_purchase,
      max_discount,
      total_quantity,
      per_user_limit,
      valid_from: new Date(valid_from).toISOString(),
      valid_until: new Date(valid_until).toISOString(),
      applicable_token_id,
      applicable_products,
      redeemed_count: 0,
      status: 'active', // active | paused | expired | exhausted
      created_at: new Date().toISOString(),
    };
    this.vouchers.set(voucher_id, voucher);

    await this.bus.publish('voucher.created', { voucher_id, code: finalCode, merchant_id, name });
    await this.audit.log({
      event_type: 'VOUCHER_CREATED', actor,
      resource_type: 'voucher', resource_id: voucher_id,
      action: 'CREATE',
      metadata: { merchant_id, code: finalCode, discount_type, discount_value, valid_until: voucher.valid_until },
    });

    return voucher;
  }

  // ============================================================
  // 2. validate() — check if voucher is usable (no actual redeem)
  // ============================================================
  async validate({ code, member_id = null, purchase_amount = null }) {
    if (!code) throw new Error('code is required');
    const voucher = Array.from(this.vouchers.values()).find((v) => v.code === code);
    if (!voucher) return { valid: false, reason: 'INVALID_CODE' };
    if (voucher.status !== 'active') return { valid: false, reason: `VOUCHER_${voucher.status.toUpperCase()}` };
    if (voucher.redeemed_count >= voucher.total_quantity) {
      return { valid: false, reason: 'EXHAUSTED' };
    }
    const now = new Date();
    if (now < new Date(voucher.valid_from)) return { valid: false, reason: 'NOT_STARTED' };
    if (now > new Date(voucher.valid_until)) return { valid: false, reason: 'EXPIRED' };

    // Per-user limit check
    if (member_id) {
      const userRedemptions = Array.from(this.redemptions.values()).filter(
        (r) => r.voucher_id === voucher.voucher_id && r.member_id === member_id
      );
      if (userRedemptions.length >= voucher.per_user_limit) {
        return { valid: false, reason: 'PER_USER_LIMIT_REACHED' };
      }
    }

    // Min purchase check
    if (purchase_amount !== null && purchase_amount < voucher.min_purchase) {
      return { valid: false, reason: 'MIN_PURCHASE_NOT_MET', min_purchase: voucher.min_purchase };
    }

    // Calculate discount
    let discount = 0;
    if (voucher.discount_type === 'percentage') {
      discount = (purchase_amount || 0) * (voucher.discount_value / 100);
    } else {
      discount = voucher.discount_value;
    }
    if (voucher.max_discount && discount > voucher.max_discount) {
      discount = voucher.max_discount;
    }

    return {
      valid: true,
      voucher_id: voucher.voucher_id,
      code: voucher.code,
      name: voucher.name,
      discount_type: voucher.discount_type,
      discount_value: voucher.discount_value,
      calculated_discount: Math.floor(discount * 100) / 100,
      final_amount: purchase_amount !== null ? Math.max(0, purchase_amount - discount) : null,
      merchant_id: voucher.merchant_id,
      valid_until: voucher.valid_until,
    };
  }

  // ============================================================
  // 3. redeem() — apply discount to a purchase
  // ============================================================
  async redeem({ code, member_id, purchase_amount, actor = 'system' }) {
    if (!code || !member_id || purchase_amount === undefined) {
      throw new Error('code, member_id, purchase_amount are required');
    }
    if (typeof purchase_amount !== 'number' || purchase_amount < 0) {
      throw new Error('purchase_amount must be non-negative');
    }

    // Validate first
    const check = await this.validate({ code, member_id, purchase_amount });
    if (!check.valid) throw new Error(`Voucher invalid: ${check.reason}`);

    const voucher = this.vouchers.get(check.voucher_id);
    const redemption_id = `VRED-${Date.now()}-${++this._idSeq}`;
    const discount = check.calculated_discount;
    const final_amount = purchase_amount - discount;

    // Record redemption
    const redemption = {
      redemption_id,
      voucher_id: voucher.voucher_id,
      code: voucher.code,
      member_id,
      purchase_amount,
      discount_amount: discount,
      final_amount,
      redeemed_at: new Date().toISOString(),
      actor,
    };
    this.redemptions.set(redemption_id, redemption);

    // Update voucher
    voucher.redeemed_count++;

    // Auto-pause if exhausted
    if (voucher.redeemed_count >= voucher.total_quantity) {
      voucher.status = 'exhausted';
    }

    await this.bus.publish('voucher.redeemed', {
      redemption_id, voucher_id: voucher.voucher_id, code: voucher.code,
      member_id, purchase_amount, discount_amount: discount, final_amount,
    });
    await this.audit.log({
      event_type: 'VOUCHER_REDEEMED', actor,
      resource_type: 'voucher_redemption', resource_id: redemption_id,
      member_id, action: 'CREATE',
      metadata: { voucher_id: voucher.voucher_id, code: voucher.code, discount_amount: discount, final_amount },
    });

    return {
      redemption_id,
      code: voucher.code,
      purchase_amount,
      discount_amount: discount,
      final_amount,
      merchant_id: voucher.merchant_id,
    };
  }

  // ============================================================
  // 4. voidVoucher() — merchant cancels
  // ============================================================
  async voidVoucher({ voucher_id, reason, actor = 'merchant' }) {
    const voucher = this.vouchers.get(voucher_id);
    if (!voucher) throw new Error(`Voucher not found: ${voucher_id}`);
    if (voucher.redeemed_count > 0) throw new Error('Cannot void voucher with redemptions');
    voucher.status = 'expired';
    voucher.void_reason = reason;
    voucher.voided_at = new Date().toISOString();

    await this.bus.publish('voucher.voided', { voucher_id, reason });
    await this.audit.log({
      event_type: 'VOUCHER_VOIDED', actor,
      resource_type: 'voucher', resource_id: voucher_id,
      action: 'DELETE', metadata: { reason },
    });
    return voucher;
  }

  // ============================================================
  // 5. listVouchers() / listRedemptions()
  // ============================================================
  async listVouchers({ merchant_id, status, limit = 50 } = {}) {
    let all = Array.from(this.vouchers.values());
    if (merchant_id) all = all.filter((v) => v.merchant_id === merchant_id);
    if (status) all = all.filter((v) => v.status === status);
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  async listRedemptions({ voucher_id, member_id, limit = 100 } = {}) {
    let all = Array.from(this.redemptions.values());
    if (voucher_id) all = all.filter((r) => r.voucher_id === voucher_id);
    if (member_id) all = all.filter((r) => r.member_id === member_id);
    all.sort((a, b) => b.redeemed_at.localeCompare(a.redeemed_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 6. getStats() — analytics
  // ============================================================
  async getStats({ merchant_id, since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    let vouchers = Array.from(this.vouchers.values());
    if (merchant_id) vouchers = vouchers.filter((v) => v.merchant_id === merchant_id);

    const redemptions = Array.from(this.redemptions.values()).filter(
      (r) => new Date(r.redeemed_at).getTime() >= sinceMs
    );
    const totalDiscount = redemptions.reduce((s, r) => s + r.discount_amount, 0);
    const totalSales = redemptions.reduce((s, r) => s + r.purchase_amount, 0);

    return {
      total_vouchers: vouchers.length,
      active_vouchers: vouchers.filter((v) => v.status === 'active').length,
      redemptions: redemptions.length,
      total_sales: totalSales,
      total_discount: totalDiscount,
      avg_discount: redemptions.length > 0 ? (totalDiscount / redemptions.length).toFixed(2) : 0,
    };
  }

  // ============================================================
  // private
  // ============================================================
  _generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoucherEngine };
}
if (typeof window !== 'undefined') {
  window.VoucherEngine = VoucherEngine;
}
