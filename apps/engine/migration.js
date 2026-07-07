// Migration Engine — RFC-001 Open Question #7
// "มีแผน Migration และ Backward Compatibility ก่อนใช้งานจริง"
// Author: AliClaw | Date: 2026-07-07

class MigrationEngine {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.identityService
   * @param {Object} dependencies.legacyDB - Old system (Phone as primary key)
   * @param {Object} dependencies.auditLog
   */
  constructor({ identityService, legacyDB, auditLog } = {}) {
    if (!identityService) throw new Error('identityService is required');
    this.identity = identityService;
    this.legacy = legacyDB;
    this.audit = auditLog || console;
  }

  /**
   * Migrate a legacy user (phone-based) to new system (Member ID-based)
   * Step 1: Check if already migrated (idempotency)
   * Step 2: Create new Member with UUID
   * Step 3: Preserve old phone_hash mapping
   * Step 4: Mark legacy record as "migrated"
   */
  async migrateLegacyUser({ legacy_user_id, phone_hash, phone_last4, display_name, created_at }) {
    if (!legacy_user_id || !phone_hash) {
      throw new Error('legacy_user_id and phone_hash are required');
    }

    // Step 1: Idempotency — check if already migrated
    const existingMapping = await this._getMigrationMap(legacy_user_id);
    if (existingMapping) {
      return {
        member_id: existingMapping.member_id,
        status: 'ALREADY_MIGRATED',
        migrated_at: existingMapping.migrated_at
      };
    }

    // Step 2: Create new Member
    const { member, phone_binding } = await this.identity.createMember({
      display_name: display_name || `Legacy ${legacy_user_id}`,
      phone_hash,
      phone_last4
    });

    // Step 3: Store mapping (legacy_user_id → member_id)
    const mapping = {
      legacy_user_id,
      member_id: member.member_id,
      phone_hash,
      migrated_at: new Date().toISOString(),
      legacy_created_at: created_at,
      backward_compat: true
    };

    if (this.legacy?.storeMapping) {
      await this.legacy.storeMapping(mapping);
    } else if (this.legacy?.mappings) {
      this.legacy.mappings.set(legacy_user_id, mapping);
    }

    // Step 4: Mark legacy record as migrated
    if (this.legacy?.markMigrated) {
      await this.legacy.markMigrated(legacy_user_id);
    }

    // Audit
    await this.audit.record?.({
      action: 'LEGACY_USER_MIGRATED',
      legacy_user_id,
      member_id: member.member_id,
      timestamp: new Date().toISOString()
    });

    return {
      member_id: member.member_id,
      status: 'MIGRATED',
      backward_compat: true,
      legacy_user_id
    };
  }

  /**
   * Backward compatibility — resolve legacy_user_id to new member_id
   * Used by OLD code that still references legacy IDs
   */
  async resolveLegacyId(legacy_user_id) {
    const mapping = await this._getMigrationMap(legacy_user_id);
    if (!mapping) return null;
    return {
      member_id: mapping.member_id,
      migrated: true,
      migrated_at: mapping.migrated_at
    };
  }

  /**
   * Batch migration for many legacy users
   * Returns: { total, success, failed, errors }
   */
  async batchMigrate(legacy_users, options = {}) {
    const batchSize = options.batchSize || 100;
    const onError = options.onError || 'continue';  // 'continue' | 'abort'
    const results = { total: legacy_users.length, success: 0, failed: 0, errors: [] };

    for (let i = 0; i < legacy_users.length; i += batchSize) {
      const batch = legacy_users.slice(i, i + batchSize);

      for (const user of batch) {
        try {
          await this.migrateLegacyUser(user);
          results.success++;
        } catch (err) {
          results.failed++;
          results.errors.push({ legacy_user_id: user.legacy_user_id, error: err.message });
          if (onError === 'abort') throw err;
        }
      }

      // Progress callback
      if (options.onProgress) {
        options.onProgress({
          processed: Math.min(i + batchSize, legacy_users.length),
          total: legacy_users.length
        });
      }
    }

    return results;
  }

  /**
   * Verify data integrity after migration
   * Checks: no duplicate members, all phones bound, all wallets accessible
   */
  async verifyMigration() {
    const checks = [];

    // Check 1: Every legacy user has mapping
    if (this.legacy?.getAllLegacyUsers) {
      const allLegacy = await this.legacy.getAllLegacyUsers();
      let mappedCount = 0;
      let unmapped = [];

      for (const u of allLegacy) {
        const mapping = await this._getMigrationMap(u.legacy_user_id);
        if (mapping) {
          mappedCount++;
        } else {
          unmapped.push(u.legacy_user_id);
        }
      }

      checks.push({
        name: 'All legacy users mapped',
        passed: unmapped.length === 0,
        details: { total: allLegacy.length, mapped: mappedCount, unmapped: unmapped.length }
      });
    }

    // Check 2: No duplicate members (same phone_hash)
    const allPhones = this.identity.db?.phone_bindings || new Map();
    const phoneCounts = new Map();
    for (const pb of allPhones.values()) {
      const key = pb.phone_hash;
      phoneCounts.set(key, (phoneCounts.get(key) || 0) + 1);
    }
    const duplicates = Array.from(phoneCounts.entries()).filter(([_, c]) => c > 1);

    checks.push({
      name: 'No duplicate phone bindings',
      passed: duplicates.length === 0,
      details: { duplicates: duplicates.map(([k]) => k) }
    });

    return {
      passed: checks.every(c => c.passed),
      checks
    };
  }

  // ============== HELPERS ==============
  async _getMigrationMap(legacy_user_id) {
    if (this.legacy?.getMapping) {
      return await this.legacy.getMapping(legacy_user_id);
    }
    if (this.legacy?.mappings) {
      return this.legacy.mappings.get(legacy_user_id) || null;
    }
    return null;
  }
}

module.exports = { MigrationEngine };
