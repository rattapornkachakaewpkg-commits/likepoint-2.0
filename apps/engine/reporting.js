// Reporting & Analytics Engine — RFC-001 Open Question #8
// Track Success Metrics: Wallet dup rate, Recovery time, Fraud, etc.
// Author: AliClaw | Date: 2026-07-07

class ReportingEngine {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.auditLog
   * @param {Object} dependencies.identityService
   */
  constructor({ auditLog, identityService } = {}) {
    this.audit = auditLog;
    this.identity = identityService;
    this.metrics = new Map();
  }

  /**
   * Track metric event
   * Usage: track('WALLET_REBIND', { duration_ms: 5000, success: true })
   */
  async track(metric_name, properties = {}) {
    const event = {
      metric: metric_name,
      ...properties,
      timestamp: new Date().toISOString()
    };

    if (!this.metrics.has(metric_name)) {
      this.metrics.set(metric_name, []);
    }
    this.metrics.get(metric_name).push(event);

    // Forward to audit log
    if (this.audit?.record) {
      await this.audit.record({ action: 'METRIC_TRACKED', ...event });
    }
  }

  /**
   * Get Success Metrics dashboard (RFC-001 §10)
   * 1. Wallet duplicate rate < 0.1%
   * 2. Account recovery success > 95%
   * 3. Phone change time < 3 min
   * 4. Point loss = 0
   * 5. Fraud reduction
   */
  async getSuccessMetrics() {
    const now = Date.now();
    const last30Days = now - 30 * 24 * 60 * 60 * 1000;

    // 1. Wallet Duplicate Rate
    const walletMetrics = this.metrics.get('WALLET_REBIND') || [];
    const totalRebinds = walletMetrics.length;
    const duplicates = walletMetrics.filter(m => m.action === 'MERGED').length;
    const walletDupRate = totalRebinds > 0 ? (duplicates / totalRebinds) * 100 : 0;

    // 2. Account Recovery Success
    const recoveryMetrics = this.metrics.get('RECOVERY') || [];
    const totalRecoveries = recoveryMetrics.length;
    const successfulRecoveries = recoveryMetrics.filter(m => m.success).length;
    const recoveryRate = totalRecoveries > 0 ? (successfulRecoveries / totalRecoveries) * 100 : 100;

    // 3. Phone Change Time
    const phoneChanges = this.metrics.get('PHONE_CHANGE') || [];
    const recentChanges = phoneChanges.filter(m => new Date(m.timestamp).getTime() > last30Days);
    const avgDuration = recentChanges.length > 0
      ? recentChanges.reduce((sum, m) => sum + (m.duration_ms || 0), 0) / recentChanges.length
      : 0;

    // 4. Point Loss
    const pointEvents = this.metrics.get('POINT_LOSS') || [];
    const totalLoss = pointEvents.reduce((sum, m) => sum + (m.amount || 0), 0);

    // 5. Fraud Events
    const fraudEvents = this.metrics.get('FRAUD_DETECTED') || [];
    const recentFraud = fraudEvents.filter(m => new Date(m.timestamp).getTime() > last30Days).length;

    return {
      period: 'last_30_days',
      metrics: {
        wallet_duplicate_rate: {
          value: walletDupRate.toFixed(3) + '%',
          target: '< 0.1%',
          pass: walletDupRate < 0.1
        },
        account_recovery_success: {
          value: recoveryRate.toFixed(2) + '%',
          target: '> 95%',
          pass: recoveryRate > 95
        },
        phone_change_avg_duration: {
          value: (avgDuration / 1000).toFixed(1) + 's',
          target: '< 180s (3 min)',
          pass: avgDuration < 180000
        },
        point_loss: {
          value: totalLoss,
          target: '0',
          pass: totalLoss === 0
        },
        fraud_events_last_30d: {
          value: recentFraud,
          target: 'significant_reduction',
          pass: recentFraud < 5
        }
      },
      overall_pass: walletDupRate < 0.1 && recoveryRate > 95 && totalLoss === 0
    };
  }

  /**
   * Get usage analytics
   */
  async getUsageAnalytics() {
    return {
      total_members: this.identity?.db?.members?.size || 0,
      total_phone_bindings: this.identity?.db?.phone_bindings?.size || 0,
      total_devices: this.identity?.db?.device_bindings?.size || 0,
      metrics_tracked: this.metrics.size,
      total_events: Array.from(this.metrics.values()).reduce((sum, arr) => sum + arr.length, 0)
    };
  }

  /**
   * Generate compliance report (PDPA)
   */
  async getComplianceReport() {
    const consents = this.identity?.db?.consents || new Map();
    const members = this.identity?.db?.members || new Map();

    const totalConsents = consents.size;
    const granted = Array.from(consents.values()).filter(c => c.granted).length;
    const revoked = totalConsents - granted;

    return {
      generated_at: new Date().toISOString(),
      total_members: members.size,
      consents: {
        total: totalConsents,
        granted,
        revoked,
        grant_rate: totalConsents > 0 ? (granted / totalConsents * 100).toFixed(2) + '%' : 'N/A'
      },
      data_retention: '7 years (per PDPA)',
      audit_logs: this.audit?.records?.length || 0
    };
  }
}

module.exports = { ReportingEngine };
