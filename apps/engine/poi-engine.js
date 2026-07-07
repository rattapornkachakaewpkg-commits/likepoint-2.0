// POI Marketing Engine — PF-7 (Phase E)
// Point-of-Interest: triggers + rewards + audience filter + cooldowns
// Closes engagement loop ("กดรับทุกเช้า" UBI habit per PVP vision)
// Author: AliClaw | Date: 2026-07-07

class POIEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.ruleStore - in-memory rule store
   * @param {Object} deps.triggerStore - in-memory trigger log
   * @param {Object} deps.memberStore - members to apply audience filter
   * @param {Object} deps.tokenEngine - to mint/credit rewards
   * @param {Object} deps.eventBus - publish poi.triggered events
   * @param {Object} deps.auditEngine - audit each trigger
   * @param {Object} deps.notificationService - notify members of reward
   */
  constructor({ ruleStore, triggerStore, memberStore, tokenEngine, eventBus, auditEngine, notificationService } = {}) {
    this.rules = ruleStore || new Map();
    this.triggers = triggerStore || new Map();
    this.members = memberStore || { get: async () => null, list: async () => [] };
    this.tokens = tokenEngine || { credit: async () => ({ txn_id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.notifier = notificationService || { send: async () => ({ delivered: true }) };
    this._idSeq = 0;
  }

  // ============================================================
  // 1. createRule() — define a POI reward rule
  // ============================================================
  async createRule({ merchant_id, token_id, name, event_type, reward_amount, reward_type = 'fixed', cooldown = null, audience_filter = {}, max_triggers_per_user = null, start_at = null, end_at = null, actor = 'system' }) {
    if (!merchant_id || !token_id || !event_type || !reward_amount) {
      throw new Error('merchant_id, token_id, event_type, reward_amount are required');
    }
    if (!['fixed', 'multiplier', 'random'].includes(reward_type)) {
      throw new Error(`Invalid reward_type: ${reward_type}`);
    }
    if (reward_amount <= 0) {
      throw new Error('reward_amount must be positive');
    }
    if (cooldown && !/^P(T?\d+H|\d+D|\d+W|M\d+)/.test(cooldown)) {
      throw new Error(`Invalid cooldown format: ${cooldown} (use ISO-8601 e.g., PT24H, P7D)`);
    }

    const rule_id = `POIR-${Date.now()}-${++this._idSeq}`;
    const rule = {
      rule_id,
      merchant_id,
      token_id,
      name: name || `${event_type} reward`,
      event_type,
      reward_amount,
      reward_type,
      cooldown,
      cooldown_ms: cooldown ? this._parseISO8601Duration(cooldown) : null,
      audience_filter,
      max_triggers_per_user,
      start_at,
      end_at,
      status: 'active',
      triggered_count: 0,
      total_rewarded: 0,
      unique_users: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.rules.set(rule_id, rule);

    await this.audit.log({
      event_type: 'POI_RULE_CREATED',
      actor,
      resource_type: 'poi_rule',
      resource_id: rule_id,
      action: 'CREATE',
      metadata: { merchant_id, token_id, event_type, reward_amount, reward_type, cooldown },
    });

    return rule;
  }

  // ============================================================
  // 2. trigger() — main entry point: user does event → get reward
  // ============================================================
  async trigger({ merchant_id, token_id, member_id, event_type, event_data = {}, idempotency_key = null, actor = 'system' }) {
    if (!merchant_id || !token_id || !member_id || !event_type) {
      throw new Error('merchant_id, token_id, member_id, event_type are required');
    }

    // Idempotency: same key → return existing
    if (idempotency_key) {
      const existing = Array.from(this.triggers.values()).find(
        (t) => t.idempotency_key === idempotency_key
      );
      if (existing) {
        return {
          trigger_id: existing.trigger_id,
          status: 'ALREADY_TRIGGERED',
          reward_amount: existing.reward_amount,
          triggered_at: existing.triggered_at,
        };
      }
    }

    // Find matching active rules
    const matchingRules = Array.from(this.rules.values()).filter(
      (r) => r.merchant_id === merchant_id
        && r.token_id === token_id
        && r.event_type === event_type
        && r.status === 'active'
    );

    if (matchingRules.length === 0) {
      return { status: 'NO_MATCHING_RULE', triggered_at: new Date().toISOString() };
    }

    // Load member for audience filter
    const member = await this.members.get(member_id);
    if (!member) {
      throw new Error(`Member not found: ${member_id}`);
    }

    const results = [];
    for (const rule of matchingRules) {
      // Time window check
      const now = Date.now();
      if (rule.start_at && new Date(rule.start_at).getTime() > now) {
        results.push({ rule_id: rule.rule_id, status: 'NOT_STARTED' });
        continue;
      }
      if (rule.end_at && new Date(rule.end_at).getTime() < now) {
        results.push({ rule_id: rule.rule_id, status: 'EXPIRED' });
        continue;
      }

      // Audience filter check
      if (rule.audience_filter && Object.keys(rule.audience_filter).length > 0) {
        if (!this._matchesAudience(member, rule.audience_filter)) {
          results.push({ rule_id: rule.rule_id, status: 'NOT_IN_AUDIENCE' });
          continue;
        }
      }

      // Cooldown check
      if (rule.cooldown_ms) {
        const lastTrigger = Array.from(this.triggers.values())
          .filter((t) => t.rule_id === rule.rule_id && t.member_id === member_id && t.status === 'REWARDED')
          .sort((a, b) => b.triggered_at.localeCompare(a.triggered_at))[0];
        if (lastTrigger) {
          const elapsed = now - new Date(lastTrigger.triggered_at).getTime();
          if (elapsed < rule.cooldown_ms) {
            const remaining = rule.cooldown_ms - elapsed;
            results.push({
              rule_id: rule.rule_id,
              status: 'COOLDOWN',
              cooldown_remaining_ms: remaining,
            });
            continue;
          }
        }
      }

      // Max triggers per user
      if (rule.max_triggers_per_user) {
        const userTriggers = Array.from(this.triggers.values()).filter(
          (t) => t.rule_id === rule.rule_id && t.member_id === member_id && t.status === 'REWARDED'
        ).length;
        if (userTriggers >= rule.max_triggers_per_user) {
          results.push({ rule_id: rule.rule_id, status: 'MAX_TRIGGERS_REACHED' });
          continue;
        }
      }

      // Calculate reward amount
      const reward_amount = this._calculateReward(rule, event_data);

      // Credit token
      let credit = null;
      try {
        credit = await this.tokens.credit({
          member_id,
          token_id: rule.token_id,
          amount: reward_amount,
          source: 'POI_REWARD',
          claim_id: `POI-${rule.rule_id}-${member_id}-${now}`,
          metadata: { rule_id: rule.rule_id, event_type, event_data },
        });
      } catch (e) {
        // Credit failed — record failed trigger
        const trigger_id = `POIT-${Date.now()}-${++this._idSeq}`;
        const failed = {
          trigger_id, rule_id: rule.rule_id, member_id, event_type,
          event_data, reward_amount, status: 'CREDIT_FAILED',
          error: e.message, idempotency_key,
          triggered_at: new Date().toISOString(),
        };
        this.triggers.set(trigger_id, failed);
        results.push({ rule_id: rule.rule_id, status: 'CREDIT_FAILED', error: e.message });
        continue;
      }

      // Record successful trigger
      const trigger_id = `POIT-${Date.now()}-${++this._idSeq}`;
      const triggerRecord = {
        trigger_id,
        rule_id: rule.rule_id,
        merchant_id,
        token_id,
        member_id,
        event_type,
        event_data,
        reward_amount,
        credit_txn_id: credit?.txn_id,
        idempotency_key,
        status: 'REWARDED',
        triggered_at: new Date().toISOString(),
        actor,
      };
      this.triggers.set(trigger_id, triggerRecord);

      // Update rule stats
      rule.triggered_count++;
      rule.total_rewarded += reward_amount;

      // Publish event
      await this.bus.publish('poi.triggered', {
        trigger_id, rule_id: rule.rule_id, member_id,
        event_type, reward_amount, credit_txn_id: credit?.txn_id,
      });

      // Notify member
      try {
        await this.notifier.send({
          member_id,
          channel: 'push',
          template: 'POI_REWARD',
          data: {
            rule_name: rule.name,
            reward_amount,
            event_type,
            token_id: rule.token_id,
          },
        });
      } catch (e) { /* notification failure doesn't fail the trigger */ }

      // Audit
      await this.audit.log({
        event_type: 'POI_TRIGGERED',
        actor,
        resource_type: 'poi_trigger',
        resource_id: trigger_id,
        member_id,
        action: 'CREATE',
        metadata: { rule_id: rule.rule_id, event_type, reward_amount, credit_txn_id: credit?.txn_id },
      });

      results.push({
        rule_id: rule.rule_id,
        status: 'REWARDED',
        trigger_id,
        reward_amount,
        credit_txn_id: credit?.txn_id,
      });
    }

    return {
      status: 'PROCESSED',
      triggered_at: new Date().toISOString(),
      results,
    };
  }

  // ============================================================
  // 3. listRules() — for merchant admin
  // ============================================================
  async listRules({ merchant_id, token_id, event_type, status, limit = 50 } = {}) {
    let all = Array.from(this.rules.values());
    if (merchant_id) all = all.filter((r) => r.merchant_id === merchant_id);
    if (token_id) all = all.filter((r) => r.token_id === token_id);
    if (event_type) all = all.filter((r) => r.event_type === event_type);
    if (status) all = all.filter((r) => r.status === status);
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 4. listTriggers() — for analytics
  // ============================================================
  async listTriggers({ merchant_id, member_id, rule_id, event_type, status, since, limit = 100 } = {}) {
    let all = Array.from(this.triggers.values());
    if (merchant_id) all = all.filter((t) => t.merchant_id === merchant_id);
    if (member_id) all = all.filter((t) => t.member_id === member_id);
    if (rule_id) all = all.filter((t) => t.rule_id === rule_id);
    if (event_type) all = all.filter((t) => t.event_type === event_type);
    if (status) all = all.filter((t) => t.status === status);
    if (since) {
      const sinceMs = new Date(since).getTime();
      all = all.filter((t) => new Date(t.triggered_at).getTime() >= sinceMs);
    }
    all.sort((a, b) => b.triggered_at.localeCompare(a.triggered_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 5. getRuleStats() — aggregated rule analytics
  // ============================================================
  async getRuleStats({ rule_id, since } = {}) {
    const rule = this.rules.get(rule_id);
    if (!rule) throw new Error(`Rule not found: ${rule_id}`);
    const sinceMs = since ? new Date(since).getTime() : 0;
    const triggers = Array.from(this.triggers.values()).filter(
      (t) => t.rule_id === rule_id
        && t.status === 'REWARDED'
        && new Date(t.triggered_at).getTime() >= sinceMs
    );
    const unique_members = new Set(triggers.map((t) => t.member_id)).size;
    return {
      rule_id,
      rule_name: rule.name,
      event_type: rule.event_type,
      reward_amount: rule.reward_amount,
      trigger_count: triggers.length,
      unique_members,
      total_rewarded: triggers.reduce((s, t) => s + t.reward_amount, 0),
      avg_per_user: unique_members > 0 ? (triggers.length / unique_members).toFixed(2) : 0,
    };
  }

  // ============================================================
  // 6. pauseRule() / resumeRule()
  // ============================================================
  async pauseRule({ rule_id, actor = 'system' }) {
    const rule = this.rules.get(rule_id);
    if (!rule) throw new Error(`Rule not found: ${rule_id}`);
    rule.status = 'paused';
    rule.updated_at = new Date().toISOString();
    await this.audit.log({
      event_type: 'POI_RULE_PAUSED', actor,
      resource_type: 'poi_rule', resource_id: rule_id,
      action: 'UPDATE', outcome: 'success',
    });
    return rule;
  }

  async resumeRule({ rule_id, actor = 'system' }) {
    const rule = this.rules.get(rule_id);
    if (!rule) throw new Error(`Rule not found: ${rule_id}`);
    rule.status = 'active';
    rule.updated_at = new Date().toISOString();
    await this.audit.log({
      event_type: 'POI_RULE_RESUMED', actor,
      resource_type: 'poi_rule', resource_id: rule_id,
      action: 'UPDATE', outcome: 'success',
    });
    return rule;
  }

  // ============================================================
  // private helpers
  // ============================================================
  _parseISO8601Duration(s) {
    // PT24H → 24*60*60*1000 = 86400000
    // P7D → 7*24*60*60*1000
    // P1W → 7 days
    // M30 → 30 days
    let ms = 0;
    const dayMatch = s.match(/P?T?(\d+)D/);
    const hourMatch = s.match(/PT?(\d+)H/);
    const weekMatch = s.match(/P(\d+)W/);
    const monthMatch = s.match(/^M(\d+)$/);
    if (weekMatch) ms += parseInt(weekMatch[1]) * 7 * 24 * 60 * 60 * 1000;
    if (dayMatch) ms += parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000;
    if (hourMatch) ms += parseInt(hourMatch[1]) * 60 * 60 * 1000;
    if (monthMatch) ms += parseInt(monthMatch[1]) * 30 * 24 * 60 * 60 * 1000;
    return ms;
  }

  _calculateReward(rule, event_data) {
    if (rule.reward_type === 'fixed') {
      return rule.reward_amount;
    }
    if (rule.reward_type === 'multiplier') {
      // event_data.amount is base, reward = amount * multiplier
      const base = event_data?.amount || 0;
      return Math.floor(base * rule.reward_amount);
    }
    if (rule.reward_type === 'random') {
      // reward_amount is the max; random between 0 and max
      return Math.floor(Math.random() * rule.reward_amount);
    }
    return rule.reward_amount;
  }

  _matchesAudience(member, filter) {
    if (!member) return false;
    if (filter.tier && member.tier !== filter.tier) return false;
    if (filter.country && member.country !== filter.country) return false;
    if (filter.opt_in !== undefined && member.opt_in !== filter.opt_in) return false;
    if (filter.min_age && (member.age || 0) < filter.min_age) return false;
    if (filter.max_age && (member.age || 0) > filter.max_age) return false;
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { POIEngine };
}
if (typeof window !== 'undefined') {
  window.POIEngine = POIEngine;
}
