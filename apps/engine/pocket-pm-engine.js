// Pocket PM Report Engine — TASK-204 (Cycle 25)
// Detects duplicate pockets + generates daily report for PM approval
// Uses PF-17 (Reporting) + PF-15 (Notification) patterns
// Author: AliClaw | Date: 2026-07-10

class PocketPMEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.pocketStore - source of pocket records
   * @param {Object} deps.auditStore - PF-5 audit log
   * @param {Object} deps.notifStore - PF-15 notification
   */
  constructor(deps = {}) {
    this.pockets = deps.pocketStore || new Map();
    this.audit = deps.auditStore || new Map();
    this.notifs = deps.notifStore || new Map();
    this.pmDecisions = new Map(); // decision log
  }

  /**
   * Detect duplicate pockets (same member + same amount + same source within window)
   * @param {string} memberId
   * @param {number} amount
   * @param {string} source
   * @param {number} windowMs - default 60 seconds
   * @returns {Array} list of duplicate pockets
   */
  detectDuplicates(memberId, amount, source, windowMs = 60000) {
    const all = Array.from(this.pockets.values())
      .filter(p => p.memberId === memberId);
    const now = Date.now();
    return all.filter(p =>
      p.amount === amount &&
      p.source === source &&
      (now - new Date(p.createdAt).getTime()) < windowMs &&
      p.status !== 'rejected'
    );
  }

  /**
   * Scan all pockets in store for duplicates
   * @returns {Array} groups of duplicate pockets
   */
  scanAllDuplicates() {
    const groups = new Map();
    for (const p of this.pockets.values()) {
      const key = `${p.memberId}|${p.amount}|${p.source}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const dupes = [];
    for (const [key, items] of groups) {
      if (items.length > 1) {
        const sorted = items.sort((a, b) =>
          new Date(a.createdAt) - new Date(b.createdAt));
        const totalDupes = items.length - 1;
        dupes.push({
          key,
          memberId: items[0].memberId,
          amount: items[0].amount,
          source: items[0].source,
          count: items.length,
          duplicates: totalDupes,
          original: sorted[0],
          copies: sorted.slice(1),
          totalImpact: totalDupes * items[0].amount
        });
      }
    }
    return dupes;
  }

  /**
   * Generate daily PM report
   * @param {string} date - YYYY-MM-DD (default: today)
   * @returns {Object} report
   */
  generateDailyReport(date = null) {
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const dupeGroups = this.scanAllDuplicates();
    const pendingDecisions = Array.from(this.pmDecisions.values())
      .filter(d => d.status === 'pending');

    return {
      date: targetDate,
      generatedAt: new Date().toISOString(),
      summary: {
        totalDuplicates: dupeGroups.length,
        affectedMembers: new Set(dupeGroups.map(d => d.memberId)).size,
        totalImpactAmount: dupeGroups.reduce((s, d) => s + d.totalImpact, 0),
        pendingPMDecisions: pendingDecisions.length
      },
      dupeGroups,
      pendingDecisions
    };
  }

  /**
   * PM records a decision on a duplicate group
   * @param {string} groupKey
   * @param {string} pmId
   * @param {string} action - 'reject_copies' | 'keep_all' | 'investigate'
   * @param {Object} options - { keepOriginal: bool, refundCopies: bool }
   * @returns {Object} decision record
   */
  recordDecision(groupKey, pmId, action, options = {}) {
    if (!['reject_copies', 'keep_all', 'investigate'].includes(action)) {
      throw new Error(`Invalid action: ${action}`);
    }
    const dupeGroups = this.scanAllDuplicates();
    const group = dupeGroups.find(d => d.key === groupKey);
    if (!group) throw new Error(`Group not found: ${groupKey}`);

    const decisionId = `DEC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const decision = {
      decisionId,
      groupKey,
      pmId,
      action,
      options,
      memberId: group.memberId,
      amount: group.amount,
      source: group.source,
      copyCount: group.duplicates,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    this.pmDecisions.set(decisionId, decision);
    return decision;
  }

  /**
   * Apply a decision (mark copies as rejected, etc.)
   * @param {string} decisionId
   * @returns {Object} result
   */
  applyDecision(decisionId) {
    const decision = this.pmDecisions.get(decisionId);
    if (!decision) throw new Error(`Decision not found: ${decisionId}`);
    if (decision.status !== 'pending') {
      throw new Error(`Decision already ${decision.status}`);
    }

    let affected = 0;
    if (decision.action === 'reject_copies') {
      for (const copy of this._findGroup(decision.groupKey).copies) {
        const pocket = this.pockets.get(copy.id);
        if (pocket && pocket.status !== 'rejected') {
          pocket.status = 'rejected';
          pocket.rejectedBy = decision.pmId;
          pocket.rejectedAt = new Date().toISOString();
          pocket.rejectionReason = 'duplicate_by_pm';
          affected++;
        }
      }
    }
    decision.status = 'applied';
    decision.appliedAt = new Date().toISOString();
    decision.affected = affected;
    return decision;
  }

  /**
   * Send PM notification (stub - integrates with PF-15)
   * @param {Object} report
   * @returns {Object} notification record
   */
  notifyPM(report) {
    const notifId = `NOTIF-POCKET-${Date.now()}`;
    const notif = {
      notifId,
      type: 'pocket_dupes_daily',
      channel: 'email',
      to: 'pm-team',
      subject: `[Pocket Report] ${report.date} — ${report.summary.totalDuplicates} กลุ่มซ้ำ`,
      summary: report.summary,
      sentAt: new Date().toISOString()
    };
    this.notifs.set(notifId, notif);
    return notif;
  }

  /**
   * List decisions by status
   * @param {string} status - 'pending' | 'applied' | 'all'
   * @returns {Array}
   */
  listDecisions(status = 'all') {
    const all = Array.from(this.pmDecisions.values());
    if (status === 'all') return all;
    return all.filter(d => d.status === status);
  }

  // private
  _findGroup(groupKey) {
    return this.scanAllDuplicates().find(d => d.key === groupKey);
  }
}

// Node.js export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PocketPMEngine;
}
