// KYC Engine — PF-16 (Phase E)
// KYC Level 2: manual review queue + document upload + reviewer approval
// Based on Constitution v0.2: "LEVEL_2 (manual review)"
// Author: AliClaw | Date: 2026-07-07

class KYCEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.applicationStore
   * @param {Object} deps.documentStore
   * @param {Object} deps.reviewerStore
   * @param {Object} deps.reviewStore
   * @param {Object} deps.auditEngine
   * @param {Object} deps.eventBus
   * @param {Object} deps.notificationService - to notify applicant + reviewer
   * @param {Object} deps.memberService - update tier after approval
   */
  constructor({ applicationStore, documentStore, reviewerStore, reviewStore, auditEngine, eventBus, notificationService, memberService } = {}) {
    this.applications = applicationStore || new Map();
    this.documents = documentStore || new Map();
    this.reviewers = reviewerStore || new Map();
    this.reviews = reviewStore || new Map();
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.notif = notificationService || { send: async () => ({ status: 'mock' }) };
    this.members = memberService || { get: async () => null, update: async () => null };
    this._idSeq = 0;
    this._roundRobinIdx = 0;
  }

  // ============================================================
  // 1. submitApplication() — applicant submits Level 2
  // ============================================================
  async submitApplication({ member_id, level = 2, business_name = null, business_license = null, tax_id = null, metadata = {}, actor = 'user' }) {
    if (!member_id) throw new Error('member_id is required');
    if (![2, 3].includes(level)) throw new Error(`This engine handles Level 2/3, got ${level}`);

    // Check if already has pending application
    const existing = Array.from(this.applications.values()).find(
      (a) => a.member_id === member_id && a.level === level && ['pending', 'in_review', 'more_info_required'].includes(a.status)
    );
    if (existing) throw new Error(`Application already exists: ${existing.application_id}`);

    const application_id = `KYC-${Date.now()}-${++this._idSeq}`;
    const now = new Date();
    const sla_hours = level === 2 ? 48 : 72; // 48h for L2, 72h for L3

    const application = {
      application_id,
      member_id,
      level,
      business_name,
      business_license,
      tax_id,
      metadata,
      status: 'pending', // pending | in_review | more_info_required | approved | rejected
      assigned_reviewer_id: null,
      submitted_at: now.toISOString(),
      sla_deadline: new Date(now.getTime() + sla_hours * 60 * 60 * 1000).toISOString(),
      reviewed_at: null,
      reviewed_by: null,
      decision: null,
      decision_reason: null,
      actor,
    };
    this.applications.set(application_id, application);

    await this.bus.publish('kyc.application_submitted', {
      application_id, member_id, level, sla_deadline: application.sla_deadline,
    });
    await this.audit.log({
      event_type: 'KYC_APPLICATION_SUBMITTED', actor,
      resource_type: 'kyc_application', resource_id: application_id,
      member_id, action: 'CREATE',
      metadata: { level, business_name, sla_deadline: application.sla_deadline },
    });

    // Auto-assign reviewer
    await this._assignReviewer(application_id);

    return application;
  }

  // ============================================================
  // 2. uploadDocument() — applicant uploads documents
  // ============================================================
  async uploadDocument({ application_id, document_type, file_name, file_url, file_size_bytes = null, mime_type = null, actor = 'user' }) {
    if (!application_id || !document_type || !file_name || !file_url) {
      throw new Error('application_id, document_type, file_name, file_url are required');
    }
    const app = this.applications.get(application_id);
    if (!app) throw new Error(`Application not found: ${application_id}`);
    if (app.status === 'approved' || app.status === 'rejected') {
      throw new Error(`Cannot upload to ${app.status} application`);
    }

    const document_id = `DOC-${Date.now()}-${++this._idSeq}`;
    const document = {
      document_id,
      application_id,
      document_type, // business_license, tax_id, id_card, bank_statement, etc.
      file_name,
      file_url,
      file_size_bytes,
      mime_type,
      uploaded_at: new Date().toISOString(),
      actor,
    };
    this.documents.set(document_id, document);

    await this.audit.log({
      event_type: 'KYC_DOCUMENT_UPLOADED', actor,
      resource_type: 'kyc_document', resource_id: document_id,
      member_id: app.member_id, action: 'CREATE',
      metadata: { application_id, document_type, file_name },
    });

    return document;
  }

  // ============================================================
  // 3. _assignReviewer() — auto-assign (round-robin)
  // ============================================================
  async _assignReviewer(application_id) {
    const app = this.applications.get(application_id);
    if (!app) return;
    const activeReviewers = Array.from(this.reviewers.values()).filter(
      (r) => r.status === 'active' && r.active
    );
    if (activeReviewers.length === 0) {
      this.applications.get(application_id).status = 'pending'; // no reviewers, wait
      return null;
    }
    // Round-robin
    const reviewer = activeReviewers[this._roundRobinIdx % activeReviewers.length];
    this._roundRobinIdx++;
    app.assigned_reviewer_id = reviewer.reviewer_id;
    app.status = 'in_review';

    await this.bus.publish('kyc.application_assigned', {
      application_id, reviewer_id: reviewer.reviewer_id,
    });
    await this.audit.log({
      event_type: 'KYC_APPLICATION_ASSIGNED', actor: 'system',
      resource_type: 'kyc_application', resource_id: application_id,
      member_id: app.member_id, action: 'UPDATE',
      metadata: { reviewer_id: reviewer.reviewer_id },
    });

    // Notify reviewer
    await this.notif.send({
      template_id: 'kyc-reviewer-assigned',
      recipient: { member_id: reviewer.reviewer_id, email: reviewer.email },
      variables: { application_id, business_name: app.business_name || 'N/A' },
    });

    return reviewer;
  }

  // ============================================================
  // 4. approve() — reviewer approves
  // ============================================================
  async approve({ application_id, reviewer_id, notes = null, actor = 'reviewer' }) {
    const app = this.applications.get(application_id);
    if (!app) throw new Error(`Application not found: ${application_id}`);
    if (app.status !== 'in_review') throw new Error(`Application is ${app.status}, can only approve in_review`);
    if (app.assigned_reviewer_id !== reviewer_id) {
      throw new Error('Only assigned reviewer can approve');
    }

    app.status = 'approved';
    app.reviewed_at = new Date().toISOString();
    app.reviewed_by = reviewer_id;
    app.decision = 'approved';
    app.decision_reason = notes;

    // Update member tier
    const newTier = app.level === 2 ? 'pro' : 'enterprise';
    await this.members.update?.(app.member_id, { tier: newTier, kyc_level: app.level });

    // Record review
    const review_id = `REV-${Date.now()}-${++this._idSeq}`;
    this.reviews.set(review_id, {
      review_id, application_id, reviewer_id, decision: 'approved', notes,
      reviewed_at: app.reviewed_at,
    });

    await this.bus.publish('kyc.application_approved', { application_id, member_id: app.member_id, new_tier: newTier });
    await this.audit.log({
      event_type: 'KYC_APPLICATION_APPROVED', actor,
      resource_type: 'kyc_application', resource_id: application_id,
      member_id: app.member_id, action: 'UPDATE',
      metadata: { reviewer_id, new_tier: newTier, notes },
    });

    // Notify applicant
    await this.notif.send({
      template_id: 'kyc-approved',
      recipient: { member_id: app.member_id },
      variables: { level: app.level, new_tier: newTier },
    });

    return app;
  }

  // ============================================================
  // 5. reject() — reviewer rejects
  // ============================================================
  async reject({ application_id, reviewer_id, reason, actor = 'reviewer' }) {
    if (!reason) throw new Error('reason is required for rejection');
    const app = this.applications.get(application_id);
    if (!app) throw new Error(`Application not found: ${application_id}`);
    if (app.status !== 'in_review') throw new Error(`Application is ${app.status}`);
    if (app.assigned_reviewer_id !== reviewer_id) throw new Error('Only assigned reviewer can reject');

    app.status = 'rejected';
    app.reviewed_at = new Date().toISOString();
    app.reviewed_by = reviewer_id;
    app.decision = 'rejected';
    app.decision_reason = reason;

    const review_id = `REV-${Date.now()}-${++this._idSeq}`;
    this.reviews.set(review_id, {
      review_id, application_id, reviewer_id, decision: 'rejected', notes: reason,
      reviewed_at: app.reviewed_at,
    });

    await this.bus.publish('kyc.application_rejected', { application_id, reason });
    await this.audit.log({
      event_type: 'KYC_APPLICATION_REJECTED', actor,
      resource_type: 'kyc_application', resource_id: application_id,
      member_id: app.member_id, action: 'UPDATE',
      metadata: { reviewer_id, reason },
    });

    // Notify applicant
    await this.notif.send({
      template_id: 'kyc-rejected',
      recipient: { member_id: app.member_id },
      variables: { level: app.level, reason },
    });

    return app;
  }

  // ============================================================
  // 6. requestMoreInfo() — reviewer asks for more docs
  // ============================================================
  async requestMoreInfo({ application_id, reviewer_id, message, actor = 'reviewer' }) {
    if (!message) throw new Error('message is required');
    const app = this.applications.get(application_id);
    if (!app) throw new Error(`Application not found: ${application_id}`);
    if (app.status !== 'in_review') throw new Error(`Application is ${app.status}`);

    app.status = 'more_info_required';
    app.decision_reason = message;

    // Extend SLA by 24h from current deadline
    const oldDeadline = new Date(app.sla_deadline);
    const newDeadline = new Date(oldDeadline.getTime() + 24 * 60 * 60 * 1000);
    app.sla_deadline = newDeadline.toISOString();

    const review_id = `REV-${Date.now()}-${++this._idSeq}`;
    this.reviews.set(review_id, {
      review_id, application_id, reviewer_id, decision: 'more_info_required', notes: message,
      reviewed_at: new Date().toISOString(),
    });

    await this.bus.publish('kyc.more_info_requested', { application_id, message, new_sla: app.sla_deadline });
    await this.audit.log({
      event_type: 'KYC_MORE_INFO_REQUESTED', actor,
      resource_type: 'kyc_application', resource_id: application_id,
      member_id: app.member_id, action: 'UPDATE',
      metadata: { reviewer_id, message, new_sla: app.sla_deadline },
    });

    await this.notif.send({
      template_id: 'kyc-more-info',
      recipient: { member_id: app.member_id },
      variables: { message, deadline: app.sla_deadline },
    });

    return app;
  }

  // ============================================================
  // 7. getStatus() — for applicant
  // ============================================================
  async getStatus(member_id) {
    if (!member_id) throw new Error('member_id is required');
    const app = Array.from(this.applications.values())
      .filter((a) => a.member_id === member_id)
      .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0];
    if (!app) return { has_application: false };
    const docs = Array.from(this.documents.values()).filter((d) => d.application_id === app.application_id);
    return {
      has_application: true,
      application_id: app.application_id,
      level: app.level,
      status: app.status,
      submitted_at: app.submitted_at,
      sla_deadline: app.sla_deadline,
      decision: app.decision,
      decision_reason: app.decision_reason,
      documents: docs.map((d) => ({ document_id: d.document_id, document_type: d.document_type, file_name: d.file_name, uploaded_at: d.uploaded_at })),
    };
  }

  // ============================================================
  // 8. getReviewerQueue() — for reviewer
  // ============================================================
  async getReviewerQueue({ reviewer_id, status, limit = 20 }) {
    let all = Array.from(this.applications.values());
    if (reviewer_id) all = all.filter((a) => a.assigned_reviewer_id === reviewer_id);
    if (status) all = all.filter((a) => a.status === status);
    // Sort by SLA deadline (urgent first)
    all.sort((a, b) => a.sla_deadline.localeCompare(b.sla_deadline));
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 9. addReviewer() — admin adds a reviewer
  // ============================================================
  async addReviewer({ reviewer_id, name, email, specializations = [], actor = 'admin' }) {
    if (!reviewer_id || !name || !email) {
      throw new Error('reviewer_id, name, email are required');
    }
    const reviewer = {
      reviewer_id, name, email, specializations,
      active: true, status: 'active',
      added_at: new Date().toISOString(),
    };
    this.reviewers.set(reviewer_id, reviewer);
    await this.audit.log({
      event_type: 'KYC_REVIEWER_ADDED', actor,
      resource_type: 'kyc_reviewer', resource_id: reviewer_id,
      action: 'CREATE', metadata: { name, email },
    });
    return reviewer;
  }

  // ============================================================
  // 10. getStats() — analytics
  // ============================================================
  async getStats({ since, reviewer_id } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    let all = Array.from(this.applications.values());
    if (reviewer_id) all = all.filter((a) => a.assigned_reviewer_id === reviewer_id);
    const recent = all.filter((a) => new Date(a.submitted_at).getTime() >= sinceMs);

    return {
      total: all.length,
      recent: recent.length,
      pending: recent.filter((a) => a.status === 'pending' || a.status === 'in_review').length,
      approved: recent.filter((a) => a.status === 'approved').length,
      rejected: recent.filter((a) => a.status === 'rejected').length,
      more_info: recent.filter((a) => a.status === 'more_info_required').length,
      approval_rate: recent.length > 0 ? ((recent.filter((a) => a.status === 'approved').length / recent.filter((a) => ['approved', 'rejected'].includes(a.status)).length) * 100).toFixed(1) : 0,
      sla_breaches: recent.filter((a) => new Date(a.sla_deadline) < new Date() && ['pending', 'in_review'].includes(a.status)).length,
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KYCEngine };
}
if (typeof window !== 'undefined') {
  window.KYCEngine = KYCEngine;
}
