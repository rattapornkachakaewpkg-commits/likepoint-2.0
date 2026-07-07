// Merchant Engine — PF-6 (Phase E)
// White-Label Loyalty Token SaaS — every BU creates, brands, and runs their own token
// Based on PVP vision (28/09/2022) + lessons learned from Likepoint 1.0 failure
// Author: AliClaw | Date: 2026-07-07

class MerchantEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.merchantStore - in-memory store (replace with DB in prod)
   * @param {Object} deps.tokenStore
   * @param {Object} deps.poiStore
   * @param {Object} deps.auditEngine - PF-5 AuditEngine for audit.log()
   * @param {Object} deps.eventBus - for publishing merchant/token/poi events
   * @param {Object} deps.kycService - validates business documents
   * @param {Object} deps.tierLimits - { starter: { tokens: 1, supply: 10000 }, pro: { tokens: 5, supply: 1000000 }, enterprise: { tokens: Infinity, supply: Infinity } }
   */
  constructor({ merchantStore, tokenStore, poiStore, auditEngine, eventBus, kycService, tierLimits } = {}) {
    this.merchants = merchantStore || new Map();
    this.tokens = tokenStore || new Map();
    this.poiRules = poiStore || new Map();
    this.audit = auditEngine || { log: async () => ({ id: 'mock', created_at: new Date().toISOString() }) };
    this.bus = eventBus || { publish: async () => {} };
    this.kyc = kycService || { verify: async () => ({ status: 'approved' }) };
    this.tierLimits = tierLimits || {
      starter:    { tokens: 1, supply: 10000, monthly_fee: 0 },
      pro:        { tokens: 5, supply: 1000000, monthly_fee: 5000 },
      enterprise: { tokens: Infinity, supply: Infinity, monthly_fee: null /* custom */ },
    };
    this._idSeq = 0;
  }

  // ============================================================
  // 1. onboardMerchant()
  // ============================================================
  async onboardMerchant({ business_name, contact_email, country, tier = 'starter', kyc_docs = null, actor = 'system' }) {
    if (!business_name || !contact_email || !country) {
      throw new Error('business_name, contact_email, country are required');
    }
    if (!['starter', 'pro', 'enterprise'].includes(tier)) {
      throw new Error(`Invalid tier: ${tier}`);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
      throw new Error(`Invalid email: ${contact_email}`);
    }
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new Error(`Invalid country code (ISO-3166 alpha-2): ${country}`);
    }

    // Duplicate business_name check (per country)
    const slug = this._slugify(business_name);
    for (const m of this.merchants.values()) {
      if (m.country === country && m.slug === slug) {
        throw new Error(`Business "${business_name}" already exists in ${country}`);
      }
    }

    // KYC requirement: pro+ needs KYC
    let kyc_status = 'not_required';
    if (tier !== 'starter') {
      if (!kyc_docs) throw new Error(`KYC documents required for ${tier} tier`);
      const kycResult = await this.kyc.verify(kyc_docs);
      kyc_status = kycResult.status; // approved, rejected, pending
      if (kyc_status === 'rejected') {
        throw new Error(`KYC rejected: ${kycResult.reason || 'unknown'}`);
      }
    } else {
      kyc_status = 'not_required';
    }

    const merchant_id = `MCH-${Date.now()}-${++this._idSeq}`;
    const api_key = `mk_live_${this._generateRandom(32)}`;

    const merchant = {
      merchant_id,
      business_name,
      slug,
      contact_email,
      country,
      tier,
      kyc_status,
      kyc_documents: kyc_docs || null,
      api_key, // would be hashed in prod
      config: {
        branding: { logo_url: null, primary_color: '#3b82f6', domain: null },
        notifications: { email: true, webhook: false },
      },
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.merchants.set(merchant_id, merchant);

    await this.bus.publish('merchant.onboarded', {
      merchant_id, business_name, tier, country, kyc_status,
    });
    await this.audit.log({
      event_type: 'MERCHANT_ONBOARDED',
      actor,
      resource_type: 'merchant',
      resource_id: merchant_id,
      action: 'CREATE',
      metadata: { business_name, tier, country, kyc_status },
      outcome: 'success',
    });

    return {
      merchant_id,
      business_name,
      tier,
      kyc_status,
      api_key, // shown ONCE — merchant must save
      created_at: merchant.created_at,
    };
  }

  // ============================================================
  // 2. createToken()
  // ============================================================
  async createToken({ merchant_id, name, symbol, decimals = 2, peg_currency = 'THB', peg_rate = 0.01, icon_url = null, metadata = {}, actor = 'system' }) {
    if (!merchant_id || !name || !symbol) {
      throw new Error('merchant_id, name, symbol are required');
    }
    const merchant = this.merchants.get(merchant_id);
    if (!merchant) throw new Error(`Merchant not found: ${merchant_id}`);
    if (merchant.status !== 'active') throw new Error(`Merchant is ${merchant.status}`);

    // Symbol uniqueness per merchant (check before tier limit to give better error)
    for (const t of this.tokens.values()) {
      if (t.merchant_id === merchant_id && t.symbol === symbol.toUpperCase()) {
        throw new Error(`Symbol "${symbol}" already used by this merchant`);
      }
    }

    // Tier limit check
    const limit = this.tierLimits[merchant.tier].tokens;
    const currentTokens = Array.from(this.tokens.values()).filter((t) => t.merchant_id === merchant_id).length;
    if (currentTokens >= limit) {
      throw new Error(`Token limit reached for ${merchant.tier} tier (${currentTokens}/${limit})`);
    }

    // Validate decimals
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error('decimals must be integer 0-18');
    }
    if (typeof peg_rate !== 'number' || peg_rate <= 0) {
      throw new Error('peg_rate must be positive number');
    }
    if (!/^[A-Z]{3}$/.test(peg_currency)) {
      throw new Error('peg_currency must be ISO-4217 (3 uppercase letters)');
    }

    const token_id = `TOK-${Date.now()}-${++this._idSeq}`;
    const token = {
      token_id,
      merchant_id,
      name,
      symbol: symbol.toUpperCase(),
      decimals,
      peg_currency,
      peg_rate,
      total_supply: 0,
      circulating_supply: 0,
      icon_url,
      metadata,
      status: 'active',
      created_at: new Date().toISOString(),
    };
    this.tokens.set(token_id, token);

    await this.bus.publish('token.created', {
      token_id, merchant_id, symbol: token.symbol, peg_currency, peg_rate,
    });
    await this.audit.log({
      event_type: 'TOKEN_CREATED',
      actor,
      resource_type: 'token',
      resource_id: token_id,
      action: 'CREATE',
      metadata: { merchant_id, name, symbol: token.symbol, peg_currency, peg_rate },
    });

    return token;
  }

  // ============================================================
  // 3. mintTokens()
  // ============================================================
  async mintTokens({ merchant_id, token_id, amount, payment_ref, actor = 'system' }) {
    if (!merchant_id || !token_id || !amount) {
      throw new Error('merchant_id, token_id, amount are required');
    }
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('amount must be positive number');
    }
    const merchant = this.merchants.get(merchant_id);
    if (!merchant) throw new Error(`Merchant not found: ${merchant_id}`);
    const token = this.tokens.get(token_id);
    if (!token) throw new Error(`Token not found: ${token_id}`);
    if (token.merchant_id !== merchant_id) throw new Error('Token does not belong to this merchant');
    if (token.status !== 'active') throw new Error(`Token is ${token.status}`);

    // Supply cap check
    const limit = this.tierLimits[merchant.tier].supply;
    if (token.total_supply + amount > limit) {
      throw new Error(`Mint would exceed supply cap (${token.total_supply + amount} > ${limit})`);
    }

    // KYC required for large mints
    if (amount > 100000 && merchant.kyc_status !== 'approved') {
      throw new Error('KYC approval required for mints > 100,000 tokens');
    }

    const mint_batch_id = `MINT-${Date.now()}-${++this._idSeq}`;

    // Atomic update
    token.total_supply += amount;
    token.circulating_supply += amount;

    const mintRecord = {
      mint_batch_id,
      merchant_id,
      token_id,
      amount,
      payment_ref: payment_ref || null,
      minted_at: new Date().toISOString(),
      actor,
    };

    await this.bus.publish('token.minted', {
      mint_batch_id, token_id, amount, new_total_supply: token.total_supply,
    });
    await this.audit.log({
      event_type: 'TOKEN_MINTED',
      actor,
      resource_type: 'token',
      resource_id: token_id,
      action: 'CREATE',
      metadata: { mint_batch_id, amount, new_supply: token.total_supply, payment_ref },
    });

    return {
      mint_batch_id,
      token_id,
      amount,
      new_total_supply: token.total_supply,
      new_circulating_supply: token.circulating_supply,
      minted_at: mintRecord.minted_at,
    };
  }

  // ============================================================
  // 4. setPOIRules()
  // ============================================================
  async setPOIRules({ merchant_id, token_id, rules, actor = 'system' }) {
    if (!merchant_id || !token_id || !Array.isArray(rules)) {
      throw new Error('merchant_id, token_id, rules[] are required');
    }
    const merchant = this.merchants.get(merchant_id);
    if (!merchant) throw new Error(`Merchant not found: ${merchant_id}`);
    const token = this.tokens.get(token_id);
    if (!token || token.merchant_id !== merchant_id) throw new Error('Token not found or wrong merchant');

    // Validate each rule
    const validEvents = ['daily_login', 'purchase', 'referral', 'review', 'birthday', 'custom'];
    const validatedRules = rules.map((rule, idx) => {
      if (!validEvents.includes(rule.event_type)) {
        throw new Error(`Rule ${idx}: invalid event_type "${rule.event_type}"`);
      }
      if (typeof rule.reward_amount !== 'number' || rule.reward_amount <= 0) {
        throw new Error(`Rule ${idx}: reward_amount must be positive number`);
      }
      if (!['fixed', 'multiplier', 'random'].includes(rule.reward_type)) {
        throw new Error(`Rule ${idx}: reward_type must be fixed|multiplier|random`);
      }
      if (rule.cooldown && !/^P(T?\d+H|\d+D|\d+W|M\d+)/.test(rule.cooldown)) {
        throw new Error(`Rule ${idx}: cooldown must be ISO-8601 duration (e.g., PT24H)`);
      }
      return {
        rule_id: `RULE-${Date.now()}-${idx}`,
        merchant_id,
        token_id,
        event_type: rule.event_type,
        reward_amount: rule.reward_amount,
        reward_type: rule.reward_type,
        cooldown: rule.cooldown || null,
        audience_filter: rule.audience_filter || {},
        status: 'active',
        triggered_count: 0,
        last_triggered_at: null,
        created_at: new Date().toISOString(),
      };
    });

    // Replace existing rules for this token
    for (const [k, v] of this.poiRules.entries()) {
      if (v.token_id === token_id) this.poiRules.delete(k);
    }
    validatedRules.forEach((r) => this.poiRules.set(r.rule_id, r));

    await this.bus.publish('poi.rules_updated', {
      merchant_id, token_id, rule_count: validatedRules.length,
    });
    await this.audit.log({
      event_type: 'POI_RULES_UPDATED',
      actor,
      resource_type: 'poi',
      resource_id: token_id,
      action: 'UPDATE',
      metadata: { merchant_id, rule_count: validatedRules.length, events: validatedRules.map((r) => r.event_type) },
    });

    return { rules: validatedRules, count: validatedRules.length };
  }

  // ============================================================
  // 5. getStats()
  // ============================================================
  async getStats({ merchant_id, since } = {}) {
    if (!merchant_id) throw new Error('merchant_id is required');
    const merchant = this.merchants.get(merchant_id);
    if (!merchant) throw new Error(`Merchant not found: ${merchant_id}`);

    const sinceMs = since ? new Date(since).getTime() : 0;

    const tokens = Array.from(this.tokens.values()).filter((t) => t.merchant_id === merchant_id);
    const total_supply = tokens.reduce((sum, t) => sum + t.total_supply, 0);
    const circulating_supply = tokens.reduce((sum, t) => sum + t.circulating_supply, 0);
    const token_count = tokens.length;

    const rules = Array.from(this.poiRules.values()).filter((r) => r.merchant_id === merchant_id);
    const recent_triggers = rules.reduce((sum, r) => {
      if (r.last_triggered_at && new Date(r.last_triggered_at).getTime() >= sinceMs) {
        return sum + r.triggered_count;
      }
      return sum;
    }, 0);

    return {
      merchant_id,
      business_name: merchant.business_name,
      tier: merchant.tier,
      kyc_status: merchant.kyc_status,
      token_count,
      total_supply,
      circulating_supply,
      poi_rule_count: rules.length,
      poi_triggers_since: recent_triggers,
      created_at: merchant.created_at,
    };
  }

  // ============================================================
  // 6. listMerchants() / listTokens() / listPOIRules() — read APIs
  // ============================================================
  async listMerchants({ status, tier, country, limit = 50 } = {}) {
    let all = Array.from(this.merchants.values());
    if (status) all = all.filter((m) => m.status === status);
    if (tier) all = all.filter((m) => m.tier === tier);
    if (country) all = all.filter((m) => m.country === country);
    return { total: all.length, items: all.slice(0, limit) };
  }

  async listTokens({ merchant_id, status, limit = 50 } = {}) {
    let all = Array.from(this.tokens.values());
    if (merchant_id) all = all.filter((t) => t.merchant_id === merchant_id);
    if (status) all = all.filter((t) => t.status === status);
    return { total: all.length, items: all.slice(0, limit) };
  }

  async listPOIRules({ merchant_id, token_id, status, limit = 50 } = {}) {
    let all = Array.from(this.poiRules.values());
    if (merchant_id) all = all.filter((r) => r.merchant_id === merchant_id);
    if (token_id) all = all.filter((r) => r.token_id === token_id);
    if (status) all = all.filter((r) => r.status === status);
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // private helpers
  // ============================================================
  _slugify(name) {
    return name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  _generateRandom(len) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MerchantEngine };
}
if (typeof window !== 'undefined') {
  window.MerchantEngine = MerchantEngine;
}
