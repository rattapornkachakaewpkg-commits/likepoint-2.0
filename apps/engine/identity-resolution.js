// Identity Resolution Engine — RFC-001 Open Question #4
// "การตรวจจับ Duplicate แบบ AI"
// Author: AliClaw | Date: 2026-07-07

class IdentityResolutionEngine {
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
   * Find potential duplicate members using multi-signal matching
   * Signals: phone_hash, device_fingerprint, IP, name similarity, email
   * @param {Object} candidate
   * @returns {Promise<Array>} matches with confidence score
   */
  async findDuplicates(candidate) {
    const matches = [];

    // Signal 1: Phone hash match (strong signal)
    if (candidate.phone_hash) {
      const byPhone = await this.identity.getMemberByPhone(candidate.phone_hash);
      if (byPhone && byPhone.member_id !== candidate.member_id) {
        matches.push({
          member_id: byPhone.member_id,
          signal: 'PHONE_HASH_MATCH',
          confidence: 0.95,
          reason: 'Same phone_hash'
        });
      }
    }

    // Signal 2: Device fingerprint match (strong)
    if (candidate.device_fingerprint) {
      const devices = this._getAllDevices();
      const deviceMatches = devices.filter(d =>
        d.device_fingerprint === candidate.device_fingerprint &&
        d.member_id !== candidate.member_id
      );
      for (const d of deviceMatches) {
        matches.push({
          member_id: d.member_id,
          signal: 'DEVICE_MATCH',
          confidence: 0.85,
          reason: 'Same device fingerprint'
        });
      }
    }

    // Signal 3: IP address match (weak)
    if (candidate.ip_address) {
      const devices = this._getAllDevices();
      const ipMatches = devices.filter(d =>
        d.ip_address === candidate.ip_address &&
        d.member_id !== candidate.member_id &&
        this._isRecent(d.last_seen_at, 7)  // within 7 days
      );
      for (const d of ipMatches) {
        matches.push({
          member_id: d.member_id,
          signal: 'IP_RECENT_MATCH',
          confidence: 0.6,
          reason: 'Same IP within 7 days'
        });
      }
    }

    // Signal 4: Name similarity (weak — Levenshtein)
    if (candidate.display_name) {
      const allMembers = await this._getAllMembers();
      for (const m of allMembers) {
        if (m.member_id === candidate.member_id) continue;
        const similarity = this._nameSimilarity(candidate.display_name, m.display_name);
        if (similarity > 0.8) {
          matches.push({
            member_id: m.member_id,
            signal: 'NAME_SIMILARITY',
            confidence: similarity * 0.5,  // 0.4 max
            reason: `Name similarity ${(similarity * 100).toFixed(0)}%`
          });
        }
      }
    }

    // Aggregate matches by member_id
    return this._aggregateMatches(matches);
  }

  /**
   * Aggregate matches per member_id and compute combined confidence
   */
  _aggregateMatches(matches) {
    const map = new Map();
    for (const m of matches) {
      if (!map.has(m.member_id)) {
        map.set(m.member_id, {
          member_id: m.member_id,
          signals: [],
          confidence: 0,
          reasons: []
        });
      }
      const entry = map.get(m.member_id);
      entry.signals.push(m.signal);
      entry.reasons.push(m.reason);
      // Combined confidence: max + bonus for multiple signals
      entry.confidence = Math.max(entry.confidence, m.confidence);
      if (entry.signals.length > 1) {
        entry.confidence = Math.min(0.99, entry.confidence + 0.05 * (entry.signals.length - 1));
      }
    }

    return Array.from(map.values())
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Auto-merge if confidence > 0.95
   * Manual review if 0.80-0.95
   * Reject if < 0.80
   */
  classifyAction(confidence) {
    if (confidence > 0.95) return { action: 'AUTO_MERGE', threshold: 0.95 };
    if (confidence > 0.80) return { action: 'MANUAL_REVIEW', threshold: 0.80 };
    return { action: 'REJECT', threshold: 0.80 };
  }

  // ============== HELPERS ==============
  _getAllDevices() {
    if (!this.identity.db?.device_bindings) return [];
    return Array.from(this.identity.db.device_bindings.values());
  }

  async _getAllMembers() {
    if (!this.identity.db?.members) return [];
    return Array.from(this.identity.db.members.values());
  }

  _isRecent(date, days) {
    if (!date) return false;
    const diff = Date.now() - new Date(date).getTime();
    return diff < days * 24 * 60 * 60 * 1000;
  }

  /**
   * Levenshtein-based name similarity
   * Returns 0-1 where 1 = identical
   */
  _nameSimilarity(a, b) {
    if (!a || !b) return 0;
    const aLower = a.toLowerCase().trim();
    const bLower = b.toLowerCase().trim();
    if (aLower === bLower) return 1;
    const distance = this._levenshtein(aLower, bLower);
    const maxLen = Math.max(aLower.length, bLower.length);
    return 1 - (distance / maxLen);
  }

  _levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,  // substitution
            matrix[i][j - 1] + 1,      // insertion
            matrix[i - 1][j] + 1       // deletion
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }
}

module.exports = { IdentityResolutionEngine };
