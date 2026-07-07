// Gift Card Engine — PF-11 (Phase E)
// Gift cards: no expiry, transferable, redeemable at any merchant
// Based on Likepoint meeting 16/12/2022: "Gift Card (ของขวัญ) ออกได้ทั้ง SME และ User"
// Author: AliClaw | Date: 2026-07-07

class GiftCardEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.cardStore
   * @param {Object} deps.txnStore
   * @param {Object} deps.memberService
   * @param {Object} deps.tokenEngine - debit buyer, credit redeemer
   * @param {Object} deps.auditEngine
   * @param {Object} deps.eventBus
   * @param {Object} deps.merchantService - get merchant info
   */
  constructor({ cardStore, txnStore, memberService, tokenEngine, auditEngine, eventBus, merchantService } = {}) {
    this.cards = cardStore || new Map();
    this.txns = txnStore || new Map();
    this.members = memberService || { get: async () => null };
    this.tokens = tokenEngine || { credit: async () => ({ txn_id: 'mock' }), debit: async () => ({ txn_id: 'mock' }) };
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.merchants = merchantService || { get: async () => null };
    this._idSeq = 0;
  }

  // ============================================================
  // 1. createCard() — issue a new gift card
  // ============================================================
  async createCard({ merchant_id, token_id, amount, issued_by, recipient_member_id = null, recipient_phone = null, message = null, design = 'standard', idempotency_key = null, actor = 'system' }) {
    if (!merchant_id || !token_id || !amount) {
      throw new Error('merchant_id, token_id, amount are required');
    }
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('amount must be positive number');
    }
    if (!issued_by) {
      throw new Error('issued_by is required (member_id or merchant_id for self-issued)');
    }

    // Idempotency
    if (idempotency_key) {
      const existing = Array.from(this.cards.values()).find((c) => c.idempotency_key === idempotency_key);
      if (existing) return existing;
    }

    // Validate merchant
    const merchant = await this.merchants.get(merchant_id);
    if (!merchant) throw new Error(`Merchant not found: ${merchant_id}`);
    if (merchant.status !== 'active') throw new Error(`Merchant is ${merchant.status}`);

    // Charge issuer (full amount + platform fee 1%)
    const fee = amount * 0.01;
    const totalCharge = amount + fee;
    const charge = await this.tokens.debit({
      member_id: issued_by,
      amount: totalCharge,
      source: 'GIFT_CARD_ISSUE',
      claim_id: `GIFT-ISSUE-${Date.now()}-${++this._idSeq}`,
      metadata: { merchant_id, amount, fee },
    });

    // Generate card code (16-char alphanumeric)
    const card_id = `GC-${Date.now()}-${++this._idSeq}`;
    const code = this._generateCode();
    const pin = this._generatePin();

    const card = {
      card_id,
      code, // 16-char, user shares this
      pin, // 6-digit, kept secret for security
      merchant_id,
      token_id,
      amount,
      fee,
      balance: amount, // current balance (decremented on partial redeem if enabled)
      issued_by,
      recipient_member_id,
      recipient_phone,
      message,
      design,
      status: 'active', // active | redeemed | voided | transferred
      issued_at: new Date().toISOString(),
      expires_at: null, // NO EXPIRY (vs Voucher)
      redeemed_at: null,
      redeemed_by: null,
      idempotency_key,
      debit_txn_id: charge.txn_id,
    };
    this.cards.set(card_id, card);

    // Record transaction
    const txn_id = `GIFT-TX-${Date.now()}-${++this._idSeq}`;
    this.txns.set(txn_id, {
      txn_id, card_id, type: 'ISSUE',
      member_id: issued_by, amount: totalCharge,
      txn_ref: charge.txn_id, created_at: new Date().toISOString(),
    });

    await this.bus.publish('gift_card.created', {
      card_id, code, merchant_id, amount, issued_by, recipient_member_id, recipient_phone,
    });
    await this.audit.log({
      event_type: 'GIFT_CARD_CREATED', actor,
      resource_type: 'gift_card', resource_id: card_id,
      member_id: issued_by, action: 'CREATE',
      metadata: { merchant_id, amount, fee, recipient_member_id, recipient_phone, message: message?.slice(0, 50) },
    });

    return { ...card, pin }; // pin shown ONCE to issuer
  }

  // ============================================================
  // 2. redeem() — recipient claims the card
  // ============================================================
  async redeem({ code, pin, member_id, idempotency_key = null, actor = 'system' }) {
    if (!code || !pin || !member_id) {
      throw new Error('code, pin, member_id are required');
    }
    const member = await this.members.get(member_id);
    if (!member) throw new Error(`Member not found: ${member_id}`);

    // Find card
    const card = Array.from(this.cards.values()).find((c) => c.code === code);
    if (!card) throw new Error('Invalid card code');

    // Idempotency
    if (idempotency_key) {
      const existingTxn = Array.from(this.txns.values()).find(
        (t) => t.idempotency_key === idempotency_key && t.type === 'REDEEM'
      );
      if (existingTxn) {
        return { status: 'ALREADY_REDEEMED', card_id: existingTxn.card_id, txn_id: existingTxn.txn_id };
      }
    }

    // Validate
    if (card.pin !== pin) throw new Error('Invalid PIN');
    if (card.status !== 'active') throw new Error(`Card is ${card.status}`);
    if (card.expires_at && new Date(card.expires_at).getTime() < Date.now()) {
      throw new Error('Card expired');
    }

    // Credit member's wallet
    const credit = await this.tokens.credit({
      member_id,
      amount: card.balance,
      source: 'GIFT_CARD_REDEEM',
      claim_id: `GIFT-REDEEM-${card.card_id}-${Date.now()}`,
      metadata: { card_id: card.card_id, code, merchant_id: card.merchant_id },
    });

    // Update card
    card.status = 'redeemed';
    card.redeemed_at = new Date().toISOString();
    card.redeemed_by = member_id;
    card.balance = 0;

    // Record transaction
    const txn_id = `GIFT-TX-${Date.now()}-${++this._idSeq}`;
    this.txns.set(txn_id, {
      txn_id, card_id: card.card_id, type: 'REDEEM',
      member_id, amount: card.amount, txn_ref: credit.txn_id,
      idempotency_key, created_at: new Date().toISOString(),
    });

    await this.bus.publish('gift_card.redeemed', {
      card_id: card.card_id, code, member_id, amount: card.amount, merchant_id: card.merchant_id,
    });
    await this.audit.log({
      event_type: 'GIFT_CARD_REDEEMED', actor,
      resource_type: 'gift_card', resource_id: card.card_id,
      member_id, action: 'CREATE',
      metadata: { amount: card.amount, credit_txn_id: credit.txn_id, merchant_id: card.merchant_id },
    });

    return {
      card_id: card.card_id,
      amount: card.amount,
      merchant_id: card.merchant_id,
      credit_txn_id: credit.txn_id,
      redeemed_at: card.redeemed_at,
    };
  }

  // ============================================================
  // 3. transfer() — transfer card to another member
  // ============================================================
  async transfer({ card_id, from_member_id, to_member_id, actor = 'user' }) {
    if (!card_id || !from_member_id || !to_member_id) {
      throw new Error('card_id, from_member_id, to_member_id are required');
    }
    const card = this.cards.get(card_id);
    if (!card) throw new Error(`Card not found: ${card_id}`);
    if (card.status !== 'active') throw new Error(`Card is ${card.status}`);
    if (card.issued_by !== from_member_id) {
      throw new Error(`Only issuer can transfer card`);
    }

    const toMember = await this.members.get(to_member_id);
    if (!toMember) throw new Error(`Recipient not found: ${to_member_id}`);

    const from = from_member_id;
    card.issued_by = to_member_id;
    card.transferred_at = new Date().toISOString();
    card.transferred_from = from;

    // Record transaction
    const txn_id = `GIFT-TX-${Date.now()}-${++this._idSeq}`;
    this.txns.set(txn_id, {
      txn_id, card_id, type: 'TRANSFER',
      member_id: from, to_member_id,
      amount: 0, created_at: new Date().toISOString(),
    });

    await this.bus.publish('gift_card.transferred', { card_id, from, to: to_member_id });
    await this.audit.log({
      event_type: 'GIFT_CARD_TRANSFERRED', actor,
      resource_type: 'gift_card', resource_id: card_id,
      member_id: from, action: 'UPDATE',
      metadata: { to_member_id },
    });

    return card;
  }

  // ============================================================
  // 4. voidCard() — issuer cancels (refund if unredeemed)
  // ============================================================
  async voidCard({ card_id, reason, actor = 'admin' }) {
    const card = this.cards.get(card_id);
    if (!card) throw new Error(`Card not found: ${card_id}`);
    if (card.status !== 'active') throw new Error(`Card is ${card.status}`);

    // Refund issuer
    await this.tokens.credit({
      member_id: card.issued_by,
      amount: card.amount + card.fee,
      source: 'GIFT_CARD_VOID_REFUND',
      claim_id: `GIFT-VOID-${card_id}-${Date.now()}`,
      metadata: { card_id, reason },
    });

    card.status = 'voided';
    card.voided_at = new Date().toISOString();
    card.void_reason = reason;

    await this.bus.publish('gift_card.voided', { card_id, reason });
    await this.audit.log({
      event_type: 'GIFT_CARD_VOIDED', actor,
      resource_type: 'gift_card', resource_id: card_id,
      member_id: card.issued_by, action: 'DELETE',
      metadata: { reason, refund: card.amount + card.fee },
    });

    return card;
  }

  // ============================================================
  // 5. listCards() / getCard() / getStats()
  // ============================================================
  async listCards({ merchant_id, issued_by, redeemed_by, status, limit = 50 } = {}) {
    let all = Array.from(this.cards.values());
    if (merchant_id) all = all.filter((c) => c.merchant_id === merchant_id);
    if (issued_by) all = all.filter((c) => c.issued_by === issued_by);
    if (redeemed_by) all = all.filter((c) => c.redeemed_by === redeemed_by);
    if (status) all = all.filter((c) => c.status === status);
    all.sort((a, b) => b.issued_at.localeCompare(a.issued_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  async getCard(card_id) {
    const card = this.cards.get(card_id);
    if (!card) throw new Error(`Card not found: ${card_id}`);
    // Strip pin from response (only shown at create)
    const { pin, ...safe } = card;
    return safe;
  }

  async getStats({ merchant_id, since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    let cards = Array.from(this.cards.values());
    if (merchant_id) cards = cards.filter((c) => c.merchant_id === merchant_id);
    const recent = cards.filter((c) => new Date(c.issued_at).getTime() >= sinceMs);
    const redeemed = recent.filter((c) => c.status === 'redeemed');
    const revenue = recent.reduce((s, c) => s + c.fee, 0);
    const volume = recent.reduce((s, c) => s + c.amount, 0);

    return {
      total_cards: cards.length,
      recent_cards: recent.length,
      redeemed_count: redeemed.length,
      redemption_rate: recent.length > 0 ? ((redeemed.length / recent.length) * 100).toFixed(1) : 0,
      total_revenue: revenue,
      total_volume: volume,
    };
  }

  // ============================================================
  // private
  // ============================================================
  _generateCode() {
    // 16-char alphanumeric (excluding confusing chars)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
    let code = '';
    for (let i = 0; i < 16; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    // Format: XXXX-XXXX-XXXX-XXXX
    return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
  }

  _generatePin() {
    return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GiftCardEngine };
}
if (typeof window !== 'undefined') {
  window.GiftCardEngine = GiftCardEngine;
}
