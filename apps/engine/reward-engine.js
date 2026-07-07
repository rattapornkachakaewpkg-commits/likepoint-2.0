// Reward Engine — Phase B: PF-3
// Resolves user feedback bugs A6, A7, A12
//
// Bugs covered:
// - A6: Lock&Earn รางวัลไม่เข้า (Android) — daily job didn't run
// - A7: auto script บันทึก reward ของ LikeWallet ไม่ทำงาน
// - A12: LikeWallet รางวัลประจำวันไม่เข้า (หลายวัน)
//
// Root cause: cron job fails silently — no retry, no audit
// Fix:
//   - Idempotent reward grant (claim_id-based)
//   - Retry on transient errors with exponential backoff
//   - Status tracking: PENDING → GRANTED | FAILED | EXPIRED
//   - Manual "force grant" via admin tool
//   - Audit trail in reward_grant_audit
//
// Reward types:
//   - DAILY_CLAIM: lock-to-win / daily check-in
//   - REFERRAL_BONUS: invite friend
//   - EVENT_BONUS: campaign / promotion
//   - MIGRATION_BONUS: AAM → LP2.0 migration incentive

class RewardEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.wallets - mini_like_wallets client
   * @param {Object} deps.ledger  - point_transactions client
   * @param {Object} deps.audit   - audit logger
   * @param {Function} [deps.notify] - notification function
   * @param {Object} [deps.config]   - { max_retries: 3, backoff_ms: 1000 }
   */
  constructor({ wallets, ledger, audit, notify, config } = {}) {
    if (!wallets || !ledger) {
      throw new Error('wallets and ledger are required');
    }
    this.wallets = wallets;
    this.ledger = ledger;
    this.audit = audit || console;
    this.notify = notify || (() => {});
    this.config = { max_retries: 3, backoff_ms: 1000, ...config };
  }

  // =================== Grant Reward (main entry) ===================
  /**
   * Grant a reward to a wallet — idempotent + retry-safe.
   * @param {Object} req
   * @param {string} req.claim_id - Unique ID (e.g. "daily-2026-07-07-P1234")
   * @param {string} req.wallet_id
   * @param {string} req.member_id
   * @param {number} req.amount
   * @param {string} req.reward_type - 'DAILY_CLAIM' | 'REFERRAL_BONUS' | 'EVENT_BONUS' | 'MIGRATION_BONUS'
   * @param {string} [req.reason]
   * @returns {Promise<{status: string, claim_id: string, attempts: number}>}
   */
  async grant(req) {
    const { claim_id, wallet_id, member_id, amount, reward_type, reason } = req;

    if (!claim_id || !wallet_id || !member_id || amount == null || !reward_type) {
      throw new Error('claim_id, wallet_id, member_id, amount, reward_type are required');
    }
    if (amount <= 0) {
      throw new Error('amount must be positive');
    }
    const validTypes = ['DAILY_CLAIM', 'REFERRAL_BONUS', 'EVENT_BONUS', 'MIGRATION_BONUS'];
    if (!validTypes.includes(reward_type)) {
      throw new Error(`reward_type must be one of ${validTypes.join(', ')}`);
    }

    // Idempotency: check if already granted
    const existing = await this.ledger.findClaim(claim_id);
    if (existing) {
      // Only short-circuit if already GRANTED; FAILED/PENDING should be re-processable
      if (existing.status === 'GRANTED') {
        await this.audit.record?.({
          action: 'REWARD_ALREADY_GRANTED',
          claim_id, wallet_id, member_id,
          previous_status: existing.status,
          bug_ref: 'A6/A7/A12'
        });
        return {
          status: existing.status, // 'GRANTED'
          claim_id,
          attempts: existing.attempts || 0,
          already_processed: true
        };
      }
      // else: fall through to retry (FAILED/PENDING)
    }

    // Retry loop with exponential backoff
    let lastErr = null;
    for (let attempt = 1; attempt <= this.config.max_retries; attempt++) {
      try {
        // 1. Verify wallet exists + not negative
        const wallet = await this.wallets.findById(wallet_id);
        if (!wallet) throw new Error(`WALLET_NOT_FOUND: ${wallet_id}`);
        if (wallet.status === 'LOCKED') throw new Error('WALLET_LOCKED');

        // 2. Credit via ledger (source of truth)
        const txn = await this.ledger.credit({
          wallet_id,
          member_id,
          amount,
          type: 'REWARD',
          claim_id,
          reward_type,
          reason: reason || `Reward: ${reward_type}`,
          created_at: new Date().toISOString()
        });

        // 3. Update wallet cache
        await this.wallets.incrementBalance(wallet_id, amount);

        // 4. Mark claim as GRANTED
        await this.ledger.markClaim(claim_id, {
          status: 'GRANTED',
          attempts: attempt,
          granted_at: new Date().toISOString(),
          txn_id: txn.txn_id
        });

        // 5. Audit
        await this.audit.record?.({
          action: 'REWARD_GRANTED',
          claim_id, wallet_id, member_id,
          amount, reward_type, attempt,
          bug_ref: 'A6/A7/A12'
        });

        // 6. Notify user
        await this.notify({
          type: 'REWARD_GRANTED',
          member_id, wallet_id, amount, reward_type
        });

        return { status: 'GRANTED', claim_id, attempts: attempt };
      } catch (err) {
        lastErr = err;
        await this.audit.record?.({
          action: 'REWARD_ATTEMPT_FAILED',
          claim_id, wallet_id, attempt, error: err.message
        });
        // Backoff before retry
        if (attempt < this.config.max_retries) {
          await new Promise((r) => setTimeout(r, this.config.backoff_ms * attempt));
        }
      }
    }

    // All retries exhausted
    await this.ledger.markClaim(claim_id, {
      status: 'FAILED',
      attempts: this.config.max_retries,
      last_error: lastErr?.message,
      failed_at: new Date().toISOString()
    });
    await this.audit.record?.({
      action: 'REWARD_FAILED',
      claim_id, wallet_id, member_id, amount, reward_type,
      error: lastErr?.message, bug_ref: 'A6/A7/A12'
    });
    return {
      status: 'FAILED',
      claim_id,
      attempts: this.config.max_retries,
      error: lastErr?.message
    };
  }

  // =================== Daily Claim (cron entry point) ===================
  /**
   * Process daily claim for a member — used by cron job.
   * @param {Object} req
   * @param {string} req.member_id
   * @param {string} req.wallet_id
   * @param {number} [req.amount=10] - default daily reward
   * @param {string} [req.date] - YYYY-MM-DD (defaults to today)
   * @returns {Promise<{status: string, claim_id: string}>}
   */
  async processDailyClaim({ member_id, wallet_id, amount = 10, date }) {
    const today = date || new Date().toISOString().slice(0, 10);
    const claim_id = `daily-${today}-${member_id}`;

    return await this.grant({
      claim_id,
      wallet_id,
      member_id,
      amount,
      reward_type: 'DAILY_CLAIM',
      reason: `Daily reward for ${today}`
    });
  }

  // =================== Lock-to-Win ===================
  /**
   * Process lock-to-win game result.
   * @param {Object} req
   * @param {string} req.member_id
   * @param {string} req.wallet_id
   * @param {number} req.amount
   * @param {string} req.game_id
   * @param {string} [req.tier='basic'] - 'basic' | 'silver' | 'gold'
   * @returns {Promise<{status: string, claim_id: string}>}
   */
  async processLockToWin({ member_id, wallet_id, amount, game_id, tier = 'basic' }) {
    if (!game_id) throw new Error('game_id is required');
    if (amount < 0) throw new Error('amount must be >= 0');

    // Lock-to-win can be 0 (no win) — record as FAILED claim for audit
    if (amount === 0) {
      const claim_id = `locktowin-${game_id}-${member_id}`;
      await this.ledger.markClaim(claim_id, {
        status: 'NO_WIN',
        attempts: 0,
        game_id, member_id, tier,
        recorded_at: new Date().toISOString()
      });
      return { status: 'NO_WIN', claim_id, attempts: 0 };
    }

    const claim_id = `locktowin-${game_id}-${member_id}`;
    return await this.grant({
      claim_id,
      wallet_id,
      member_id,
      amount,
      reward_type: 'EVENT_BONUS',
      reason: `Lock-to-win ${tier} (game ${game_id})`
    });
  }

  // =================== Manual Replay (admin tool) ===================
  /**
   * Replay a failed reward — used by admin to fix A12 (multi-day missing rewards).
   * @param {string} claim_id
   * @param {string} triggered_by - 'admin_user_id' | 'system'
   * @returns {Promise<{status: string, claim_id: string, attempts: number}>}
   */
  async replayFailed(claim_id, triggered_by = 'admin') {
    const claim = await this.ledger.findClaim(claim_id);
    if (!claim) throw new Error(`Claim ${claim_id} not found`);
    if (claim.status !== 'FAILED') {
      throw new Error(`Claim ${claim_id} is not FAILED (current: ${claim.status})`);
    }

    // Reset and re-grant
    await this.ledger.markClaim(claim_id, { status: 'PENDING', reset_at: new Date().toISOString() });
    await this.audit.record?.({
      action: 'REWARD_REPLAY',
      claim_id, triggered_by, bug_ref: 'A6/A7/A12'
    });

    return await this.grant({
      claim_id,
      wallet_id: claim.wallet_id,
      member_id: claim.member_id,
      amount: claim.amount,
      reward_type: claim.reward_type,
      reason: `Replay: ${claim.reason || 'admin fix'}`
    });
  }

  // =================== Bulk Daily Run (cron) ===================
  /**
   * Bulk process daily claims for all eligible members.
   * Used by nightly cron — robust to partial failures.
   * @param {Array} members - [{member_id, wallet_id}]
   * @param {number} [daily_amount=10]
   * @returns {Promise<{total: number, granted: number, failed: number, already: number}>}
   */
  async runDailyBatch(members, daily_amount = 10) {
    const today = new Date().toISOString().slice(0, 10);
    const results = { total: members.length, granted: 0, failed: 0, already: 0 };

    for (const m of members) {
      try {
        const r = await this.processDailyClaim({
          member_id: m.member_id,
          wallet_id: m.wallet_id,
          amount: daily_amount,
          date: today
        });
        if (r.status === 'GRANTED') results.granted++;
        else if (r.already_processed) results.already++;
        else if (r.status === 'FAILED') results.failed++;
      } catch (e) {
        results.failed++;
        await this.audit.record?.({
          action: 'DAILY_BATCH_ERROR',
          member_id: m.member_id,
          error: e.message
        });
      }
    }
    await this.audit.record?.({
      action: 'DAILY_BATCH_COMPLETE',
      date: today,
      ...results
    });
    return results;
  }
}

// =================== EXPORTS ===================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RewardEngine };
}
if (typeof window !== 'undefined') {
  window.RewardEngine = RewardEngine;
}
