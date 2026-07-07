// FX Engine — PF-8 (Phase E)
// Multi-Currency & Cross-Border — peg-locked tokens, FX rates, country mapping
// Based on Kowit rule (5/10/2022): "1 Likepoint = 1 สตางค์ — same rate same country"
// Author: AliClaw | Date: 2026-07-07

class FXEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.rateStore - FX rate storage
   * @param {Object} deps.countryStore - country → currency mapping
   * @param {Object} deps.auditEngine - audit FX changes
   * @param {Object} deps.eventBus - publish fx events
   * @param {Object} deps.fxProvider - external rate provider (mock for now)
   */
  constructor({ rateStore, countryStore, auditEngine, eventBus, fxProvider } = {}) {
    this.rates = rateStore || new Map();
    this.countries = countryStore || new Map();
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.provider = fxProvider || { getRate: async () => 1.0 };
    this._idSeq = 0;
  }

  // ============================================================
  // 1. setCountryCurrency() — register country → currency mapping
  // ============================================================
  async setCountryCurrency({ country_code, currency_code, currency_name, decimals = 2, actor = 'admin' }) {
    if (!country_code || !currency_code) {
      throw new Error('country_code, currency_code are required');
    }
    if (!/^[A-Z]{2}$/.test(country_code)) {
      throw new Error(`Invalid country_code (ISO-3166 alpha-2): ${country_code}`);
    }
    if (!/^[A-Z]{3}$/.test(currency_code)) {
      throw new Error(`Invalid currency_code (ISO-4217): ${currency_code}`);
    }

    const record = {
      country_code,
      currency_code,
      currency_name: currency_name || currency_code,
      decimals,
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    this.countries.set(country_code, record);

    await this.audit.log({
      event_type: 'COUNTRY_CURRENCY_SET',
      actor,
      resource_type: 'country',
      resource_id: country_code,
      action: 'CREATE',
      metadata: { currency_code, currency_name, decimals },
    });

    return record;
  }

  // ============================================================
  // 2. setFXRate() — define FX rate between 2 currencies
  // ============================================================
  async setFXRate({ from_currency, to_currency, rate, source = 'manual', actor = 'admin' }) {
    if (!from_currency || !to_currency || rate === undefined) {
      throw new Error('from_currency, to_currency, rate are required');
    }
    if (typeof rate !== 'number' || rate <= 0) {
      throw new Error('rate must be positive number');
    }
    if (from_currency === to_currency && rate !== 1) {
      throw new Error(`Same currency ${from_currency} must have rate 1, got ${rate}`);
    }

    const rate_id = `FXR-${Date.now()}-${++this._idSeq}`;
    const record = {
      rate_id,
      from_currency,
      to_currency,
      rate,
      source, // manual, provider, computed
      effective_at: new Date().toISOString(),
      expires_at: null,
      actor,
    };
    const key = `${from_currency}:${to_currency}`;
    this.rates.set(key, record);

    await this.bus.publish('fx.rate_changed', { from_currency, to_currency, rate, source });
    await this.audit.log({
      event_type: 'FX_RATE_SET',
      actor,
      resource_type: 'fx_rate',
      resource_id: rate_id,
      action: 'CREATE',
      metadata: { from_currency, to_currency, rate, source },
    });

    return record;
  }

  // ============================================================
  // 3. refreshFromProvider() — auto-update from external source
  // ============================================================
  async refreshFromProvider({ pairs, actor = 'system' } = {}) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new Error('pairs array is required');
    }
    const updated = [];
    for (const { from, to } of pairs) {
      try {
        const rate = await this.provider.getRate(from, to);
        if (typeof rate === 'number' && rate > 0) {
          const r = await this.setFXRate({ from_currency: from, to_currency: to, rate, source: 'provider', actor });
          updated.push(r);
        }
      } catch (e) {
        // continue with other pairs
      }
    }
    return { updated_count: updated.length, rates: updated };
  }

  // ============================================================
  // 4. convert() — convert amount between currencies
  // ============================================================
  async convert({ amount, from_currency, to_currency, use_stale = false }) {
    if (typeof amount !== 'number' || amount < 0) {
      throw new Error('amount must be non-negative number');
    }
    if (!from_currency || !to_currency) {
      throw new Error('from_currency, to_currency are required');
    }
    if (from_currency === to_currency) {
      return { amount, converted: amount, rate: 1, from_currency, to_currency, source: 'identity' };
    }

    // Direct rate
    const directKey = `${from_currency}:${to_currency}`;
    if (this.rates.has(directKey)) {
      const r = this.rates.get(directKey);
      if (this._isRateValid(r) || use_stale) {
        return {
          amount,
          converted: amount * r.rate,
          rate: r.rate,
          from_currency,
          to_currency,
          source: 'direct',
          rate_id: r.rate_id,
        };
      }
    }

    // Inverse rate
    const inverseKey = `${to_currency}:${from_currency}`;
    if (this.rates.has(inverseKey)) {
      const r = this.rates.get(inverseKey);
      if (this._isRateValid(r) || use_stale) {
        const inverseRate = 1 / r.rate;
        return {
          amount,
          converted: amount * inverseRate,
          rate: inverseRate,
          from_currency,
          to_currency,
          source: 'inverse',
          rate_id: r.rate_id,
        };
      }
    }

    // Triangulate via USD or THB
    const hub = await this._findHub(from_currency, to_currency);
    if (hub) {
      const r1 = this._getRawRate(from_currency, hub);
      const r2 = this._getRawRate(hub, to_currency);
      if (r1 && r2) {
        const rate = r1 * r2;
        return {
          amount,
          converted: amount * rate,
          rate,
          from_currency,
          to_currency,
          source: `triangulated:${hub}`,
        };
      }
    }

    throw new Error(`No FX rate available for ${from_currency} → ${to_currency}`);
  }

  // ============================================================
  // 5. convertTokenPeg() — convert token amount using its peg
  // ============================================================
  async convertTokenPeg({ amount, token_peg_currency, token_peg_rate, target_currency }) {
    // amount is in token units, pegged at peg_rate per peg_currency
    // e.g., 100 BCP @ 0.01 THB/token = 1 THB
    const pegValue = amount * token_peg_rate;
    // Then convert peg currency to target
    if (token_peg_currency === target_currency) {
      return { original_amount: amount, peg_value: pegValue, final_value: pegValue, currency: target_currency, source: 'peg' };
    }
    const fx = await this.convert({ amount: pegValue, from_currency: token_peg_currency, to_currency: target_currency });
    return {
      original_amount: amount,
      peg_value: pegValue,
      final_value: fx.converted,
      currency: target_currency,
      fx_rate: fx.rate,
      source: `peg+${fx.source}`,
    };
  }

  // ============================================================
  // 6. getCountryCurrency() — lookup
  // ============================================================
  async getCountryCurrency(country_code) {
    const record = this.countries.get(country_code);
    if (!record) throw new Error(`Country not registered: ${country_code}`);
    return record;
  }

  // ============================================================
  // 7. getRate() — get current rate
  // ============================================================
  async getRate({ from_currency, to_currency }) {
    const fx = await this.convert({ amount: 1, from_currency, to_currency });
    return { from_currency, to_currency, rate: fx.rate, source: fx.source };
  }

  // ============================================================
  // 8. listRates() — for admin dashboard
  // ============================================================
  async listRates({ from_currency, to_currency, source, limit = 100 } = {}) {
    let all = Array.from(this.rates.values());
    if (from_currency) all = all.filter((r) => r.from_currency === from_currency);
    if (to_currency) all = all.filter((r) => r.to_currency === to_currency);
    if (source) all = all.filter((r) => r.source === source);
    all.sort((a, b) => b.effective_at.localeCompare(a.effective_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 9. listCountries()
  // ============================================================
  async listCountries({ status, limit = 200 } = {}) {
    let all = Array.from(this.countries.values());
    if (status) all = all.filter((c) => c.status === status);
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 10. computeDisplayAmount() — for UI display
  // ============================================================
  async computeDisplayAmount({ amount, token_peg_currency, token_peg_rate, viewer_country }) {
    const viewer = await this.getCountryCurrency(viewer_country);
    const converted = await this.convertTokenPeg({
      amount,
      token_peg_currency,
      token_peg_rate,
      target_currency: viewer.currency_code,
    });
    return {
      amount,
      viewer_currency: viewer.currency_code,
      viewer_amount: converted.final_value,
      formatted: this._formatMoney(converted.final_value, viewer.currency_code, viewer.decimals),
    };
  }

  // ============================================================
  // private helpers
  // ============================================================
  _isRateValid(record) {
    if (!record.expires_at) return true;
    return new Date(record.expires_at).getTime() > Date.now();
  }

  _getRawRate(from, to) {
    const direct = this.rates.get(`${from}:${to}`);
    if (direct && this._isRateValid(direct)) return direct.rate;
    const inverse = this.rates.get(`${to}:${from}`);
    if (inverse && this._isRateValid(inverse)) return 1 / inverse.rate;
    return null;
  }

  async _findHub(from, to) {
    // Try common hubs: USD, THB
    const hubs = ['USD', 'THB'];
    for (const hub of hubs) {
      if (hub === from || hub === to) continue;
      if (this._getRawRate(from, hub) && this._getRawRate(hub, to)) {
        return hub;
      }
    }
    return null;
  }

  _formatMoney(amount, currency, decimals = 2) {
    const formatted = Number(amount).toFixed(decimals);
    return `${formatted} ${currency}`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FXEngine };
}
if (typeof window !== 'undefined') {
  window.FXEngine = FXEngine;
}
