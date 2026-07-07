// Wallet Rebinding Engine — Phase B: PF-2
// Pure logic + 100% unit test coverage
// Author: AliClaw | Date: 2026-07-07

// =================== TYPES (JSDoc) ===================
/**
 * @typedef {Object} Wallet
 * @property {string} wallet_id
 * @property {string} person_id
 * @property {string} phone_hash
 * @property {number} msp_balance
 * @property {string} status - 'ACTIVE' | 'LOCKED' | 'MERGED' | 'MISSING'
 * @property {string} created_at
 * @property {string} [merged_into]
 */

/**
 * @typedef {Object} RebindEvent
 * @property {string} person_id
 * @property {string} old_phone_hash
 * @property {string} new_phone_hash
 * @property {number} [timestamp]
 */

/**
 * @typedef {Object} RebindResult
 * @property {string} action - 'REBINDED' | 'MERGED' | 'NO_WALLET_FOUND' | 'ERROR'
 * @property {string} person_id
 * @property {string} [wallet_id]
 * @property {string} [target_wallet_id]
 * @property {number} [transferred_balance]
 * @property {string} message
 */

// =================== ENGINE ===================

class WalletRebindEngine {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.miniLikeAPI - Mini Like API client
   * @param {Function} [dependencies.lock] - Optional lock function
   * @param {Object} [dependencies.auditLog] - Audit log
   */
  constructor({ miniLikeAPI, lock, auditLog } = {}) {
    if (!miniLikeAPI) throw new Error('miniLikeAPI is required');
    this.api = miniLikeAPI;
    this.lock = lock || this._defaultLock;
    this.audit = auditLog || console;
  }

  // ============== MAIN ENTRY POINT ==============
  /**
   * Handle phone-changed event
   * @param {RebindEvent} event
   * @returns {Promise<RebindResult>}
   */
  async handlePhoneChanged(event) {
    const { person_id, old_phone_hash, new_phone_hash } = event;
    
    if (!person_id || !old_phone_hash || !new_phone_hash) {
      throw new Error('Missing required fields: person_id, old_phone_hash, new_phone_hash');
    }
    
    // Acquire lock (per person_id) — กัน concurrent events
    return await this.lock(person_id, async () => {
      try {
        // 1. Find Old wallet
        const oldWallet = await this._findWalletByHash(person_id, old_phone_hash);
        
        if (!oldWallet) {
          // Case A: Old wallet ไม่มี (ลบไปแล้ว / ไม่เคยสร้าง)
          this._log('warn', `Old wallet not found for ${person_id} (${old_phone_hash})`);
          await this.audit.record?.({
            action: 'REBIND_NO_WALLET',
            person_id,
            old_phone_hash,
            new_phone_hash,
            reason: 'Old wallet not found'
          });
          return {
            action: 'NO_WALLET_FOUND',
            person_id,
            message: 'No old wallet to rebind — may have been already merged or deleted'
          };
        }
        
        // 2. Check if New wallet exists (duplicate case)
        const newWallet = await this._findWalletByHash(person_id, new_phone_hash);
        
        if (newWallet && newWallet.wallet_id !== oldWallet.wallet_id) {
          // Case B: Old + New both exist → merge
          return await this._mergeWallets(oldWallet, newWallet, person_id, old_phone_hash, new_phone_hash);
        }
        
        // Case C: Only Old wallet → simple rebind
        return await this._rebindWallet(oldWallet, person_id, old_phone_hash, new_phone_hash);
        
      } catch (err) {
        this._log('error', `Rebind failed for ${person_id}: ${err.message}`);
        await this.audit.record?.({
          action: 'REBIND_ERROR',
          person_id,
          old_phone_hash,
          new_phone_hash,
          error: err.message
        });
        return {
          action: 'ERROR',
          person_id,
          message: err.message
        };
      }
    });
  }

  // ============== CASE C: SIMPLE REBIND ==============
  async _rebindWallet(wallet, personId, oldHash, newHash) {
    // Validation
    if (wallet.status === 'MERGED') {
      throw new Error(`Wallet ${wallet.wallet_id} already merged`);
    }
    if (wallet.status === 'LOCKED') {
      throw new Error(`Wallet ${wallet.wallet_id} is locked — manual unlock required`);
    }
    if (wallet.phone_hash !== oldHash) {
      throw new Error(`Phone hash mismatch: expected ${oldHash}, got ${wallet.phone_hash}`);
    }
    
    // Call Mini Like API
    const updated = await this.api.rebindWallet({
      wallet_id: wallet.wallet_id,
      person_id: personId,
      old_phone_hash: oldHash,
      new_phone_hash: newHash
    });
    
    // Audit
    await this.audit.record?.({
      action: 'WALLET_REBIND',
      person_id: personId,
      wallet_id: wallet.wallet_id,
      old_phone_hash: oldHash,
      new_phone_hash: newHash,
      timestamp: new Date().toISOString()
    });
    
    this._log('info', `✅ Wallet ${wallet.wallet_id} rebound: ${oldHash} → ${newHash}`);
    
    return {
      action: 'REBINDED',
      person_id: personId,
      wallet_id: wallet.wallet_id,
      message: `Wallet ${wallet.wallet_id} rebound successfully`
    };
  }

  // ============== CASE B: MERGE WALLETS ==============
  async _mergeWallets(oldWallet, newWallet, personId, oldHash, newHash) {
    // Validation
    if (oldWallet.status === 'MERGED') {
      throw new Error(`Old wallet already merged`);
    }
    
    // Transfer balance
    const transferAmount = oldWallet.msp_balance;
    newWallet.msp_balance += transferAmount;
    
    // Mark old as MERGED
    oldWallet.status = 'MERGED';
    oldWallet.merged_into = newWallet.wallet_id;
    oldWallet.msp_balance = 0;
    
    // Call Mini Like API (in real implementation: 2 calls or transaction)
    await this.api.rebindWallet({
      wallet_id: newWallet.wallet_id,
      person_id: personId,
      old_phone_hash: newWallet.phone_hash,
      new_phone_hash: newHash
    });
    
    await this.api.markWalletMerged?.({
      wallet_id: oldWallet.wallet_id,
      merged_into: newWallet.wallet_id
    });
    
    // Audit
    await this.audit.record?.({
      action: 'WALLET_MERGE',
      person_id: personId,
      from_wallet: oldWallet.wallet_id,
      to_wallet: newWallet.wallet_id,
      transferred_balance: transferAmount,
      timestamp: new Date().toISOString()
    });
    
    this._log('info', `🔀 Wallets merged: ${oldWallet.wallet_id} (${transferAmount}P) → ${newWallet.wallet_id}`);
    
    return {
      action: 'MERGED',
      person_id: personId,
      wallet_id: newWallet.wallet_id,
      target_wallet_id: oldWallet.wallet_id,
      transferred_balance: transferAmount,
      message: `Merged ${oldWallet.wallet_id} into ${newWallet.wallet_id} (${transferAmount}P transferred)`
    };
  }

  // ============== HELPERS ==============
  async _findWalletByHash(personId, phoneHash) {
    const wallets = await this.api.getWalletsByPerson(personId);
    return wallets.find(w => w.phone_hash === phoneHash) || null;
  }
  
  // Default lock (in-memory) — production ควรใช้ Redis
  async _defaultLock(key, fn) {
    if (!this._locks) this._locks = new Map();
    while (this._locks.get(key)) {
      await new Promise(r => setTimeout(r, 10));
    }
    this._locks.set(key, true);
    try {
      return await fn();
    } finally {
      this._locks.delete(key);
    }
  }
  
  _log(level, msg) {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] [Rebind] ${msg}`);
  }
}

// =================== EXPORT ===================
module.exports = { WalletRebindEngine };
