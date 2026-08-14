// Role Approval Engine — Phase F: PF-23
// Resolves LP-FEED-2026-08-14 issues #10 + #11
//
// Bugs covered (from วิชัย(ขวัญ) feedback 2026-08-14):
//   - #10: Invite user เข้า role → แจ้งเตือนห้องรับใช้/pkg_support ไม่สร้างกลุ่ม approve
//   - #11: Spec — request เข้ากลุ่ม ทำได้เฉพาะ merchant_admin_console + แจ้งเฉพาะ superadmin role
//
// Root cause (#10):
//   - RoleInviteEngine.requestInvite() published notification only
//   - Did NOT publish `role.invite.requested` event for approval-group engine
//   - ApprovalGroupEngine.createFromInvite() never triggered
//
// Fix:
//   - requestInvite() → publish 2 events: notification + invite.requested
//   - EventBusEngine.subscribe('role.invite.requested', ApprovalGroupEngine.createFromInvite)
//   - ApprovalGroupEngine → INSERT into role_approval_groups + notify superadmin
//   - castVote() → RLS enforces superadmin-only + close_approval_group_if_done()
//
// Spec (#11):
//   - source_console = 'merchant_admin_console' (RLS enforced)
//   - voter_role = 'superadmin' (RLS enforced)
//   - General admin role CANNOT see/approve invites
//
// Topics:
//   - 'role.invite.requested'   — InviteEngine → ApprovalGroupEngine
//   - 'role.approval.opened'    — ApprovalGroupEngine → notify superadmin
//   - 'role.invite.approved'    — Vote approved → role active
//   - 'role.invite.rejected'    — Vote rejected → invite cancelled

class RoleInviteEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.eventBus - EventBusEngine instance
   * @param {Object} deps.audit - audit logger
   * @param {Object} deps.notification - notifier (Feishu / line / pkg_support)
   * @param {Object} deps.store - persistence (default: in-memory)
   */
  constructor({ eventBus, audit, notification, store } = {}) {
    if (!eventBus) throw new Error('eventBus required');
    this.eventBus = eventBus;
    this.audit = audit || console;
    this.notification = notification || console;
    this.store = store || this._defaultStore();
    this.invitations = new Map();
  }

  _defaultStore() {
    return {
      saveInvitation: async (inv) => { this.invitations.set(inv.invitation_id, inv); return inv; },
      findInvitation: async (id) => this.invitations.get(id),
      findPendingByInvitee: async (user_id) => {
        return Array.from(this.invitations.values()).filter(
          (i) => i.invitee_user_id === user_id && i.status === 'pending'
        );
      },
      updateInvitation: async (id, patch) => {
        const cur = this.invitations.get(id);
        if (!cur) return null;
        const next = { ...cur, ...patch };
        this.invitations.set(id, next);
        return next;
      },
    };
  }

  /**
   * Request role invitation for a user.
   * Spec (#11): only via merchant_admin_console.
   * Workflow (#10 fix):
   *   1) INSERT role_invitation (status=pending)
   *   2) Publish notification to ห้องรับใช้/pkg_support (legacy behavior)
   *   3) Publish role.invite.requested event → ApprovalGroupEngine creates group
   *   4) Audit log: invite.created
   *
   * @param {Object} params
   * @param {string} params.tenant_id
   * @param {string} [params.merchant_id]
   * @param {string} params.invitee_user_id
   * @param {string} params.invitee_phone
   * @param {string} params.role_code - one of roles.role_code
   * @param {string} params.invited_by - inviter user_id
   * @param {string} [params.source_console='merchant_admin_console']
   * @param {string} [params.notify_room='ห้องรับใช้'] - ห้องรับใช้ | pkg_support
   * @param {Object} [params.payload]
   * @returns {Promise<{invitation_id: string, status: string, approval_group_id: string|null}>}
   */
  async requestInvite({
    tenant_id,
    merchant_id = null,
    invitee_user_id,
    invitee_phone,
    role_code,
    invited_by,
    source_console = 'merchant_admin_console',
    notify_room = 'ห้องรับใช้',
    payload = {},
  }) {
    // Validate required fields
    if (!tenant_id) throw new Error('tenant_id required');
    if (!invitee_user_id) throw new Error('invitee_user_id required');
    if (!invitee_phone) throw new Error('invitee_phone required');
    if (!role_code) throw new Error('role_code required');
    if (!invited_by) throw new Error('invited_by required');

    // Spec #11: source console lock
    if (source_console !== 'merchant_admin_console') {
      throw new Error(`source_console must be 'merchant_admin_console' (spec rule). Got: ${source_console}`);
    }

    // Spec: only valid roles
    const validRoles = ['superadmin', 'admin', 'merchant_admin', 'viewer'];
    if (!validRoles.includes(role_code)) {
      throw new Error(`Invalid role_code: ${role_code}. Must be one of ${validRoles.join(', ')}`);
    }

    const invitation_id = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const invitation = {
      invitation_id,
      tenant_id,
      merchant_id,
      invitee_user_id,
      invitee_phone,
      role_code,
      invited_by,
      source_console,
      status: 'pending',
      approval_group_id: null,
      payload,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    // Step 1: Save invitation
    await this.store.saveInvitation(invitation);

    // Step 2: Legacy notification (ห้องรับใช้ / pkg_support) — preserved from old behavior
    await this.notification.notify?.({
      room: notify_room,
      title: `[Role Invite] ${invitee_user_id} → ${role_code}`,
      body: `Invited by ${invited_by}. Tenant: ${tenant_id}. Awaiting approval.`,
      metadata: { invitation_id, role_code, tenant_id, invitee_user_id },
    });

    // Step 3: Publish role.invite.requested event → ApprovalGroupEngine will subscribe
    const pub = await this.eventBus.publish('role.invite.requested', {
      invitation_id,
      tenant_id,
      merchant_id,
      invitee_user_id,
      invitee_phone,
      role_code,
      invited_by,
      notify_room,
    });

    // Step 4: Audit
    await this.audit.log?.({
      action: 'invite.created',
      tenant_id,
      actor_user_id: invited_by,
      actor_role: 'unknown',  // caller should set via context
      details: { invitation_id, role_code, invitee_user_id, source_console, event_id: pub.event_id },
    });

    // Return current snapshot (approval_group_id may be set async via event handler)
    const stored = await this.store.findInvitation(invitation_id);
    return {
      invitation_id: stored.invitation_id,
      status: stored.status,
      approval_group_id: stored.approval_group_id,
      event_id: pub.event_id,
      notify_room,
      expires_at: stored.expires_at,
    };
  }

  /**
   * List pending invitations for a user.
   * @param {string} user_id
   * @returns {Promise<Array>}
   */
  async listPendingForUser(user_id) {
    return await this.store.findPendingByInvitee(user_id);
  }

  /**
   * Cancel a pending invitation (by inviter or admin).
   */
  async cancelInvitation({ invitation_id, cancelled_by }) {
    const inv = await this.store.findInvitation(invitation_id);
    if (!inv) throw new Error(`Invitation not found: ${invitation_id}`);
    if (inv.status !== 'pending') {
      throw new Error(`Cannot cancel invitation in status: ${inv.status}`);
    }
    const updated = await this.store.updateInvitation(invitation_id, {
      status: 'cancelled',
      decided_at: new Date().toISOString(),
      decided_by: cancelled_by,
    });
    await this.audit.log?.({
      action: 'invite.cancelled',
      tenant_id: inv.tenant_id,
      actor_user_id: cancelled_by,
      actor_role: 'unknown',
      details: { invitation_id },
    });
    return updated;
  }
}

class ApprovalGroupEngine {
  /**
   * Subscribes to 'role.invite.requested' and creates approval group.
   * Spec (#11): notify superadmin only (never admin role).
   */
  constructor({ eventBus, audit, notification, store, config } = {}) {
    if (!eventBus) throw new Error('eventBus required');
    this.eventBus = eventBus;
    this.audit = audit || console;
    this.notification = notification || console;
    this.store = store || this._defaultStore();
    this.config = { min_approvals: 1, ...config };
    this.groups = new Map();
    this.votes = new Map();
    this._subscribed = false;
  }

  _defaultStore() {
    return {
      saveGroup: async (g) => { this.groups.set(g.group_id, g); return g; },
      findGroup: async (id) => this.groups.get(id),
      saveVote: async (v) => {
        const key = `${v.group_id}:${v.voter_user_id}`;
        if (this.votes.has(key)) throw new Error('already voted');
        this.votes.set(key, v);
        return v;
      },
      countVotes: async (group_id) => {
        const votes = Array.from(this.votes.values()).filter((v) => v.group_id === group_id);
        return {
          approve: votes.filter((v) => v.decision === 'approve').length,
          reject: votes.filter((v) => v.decision === 'reject').length,
        };
      },
      findGroupsByStatus: async (status) => {
        return Array.from(this.groups.values()).filter((g) => g.status === status);
      },
      closeGroup: async (group_id, decision) => {
        const cur = this.groups.get(group_id);
        if (!cur) return null;
        const next = {
          ...cur,
          status: 'closed',
          final_decision: decision,
          closed_at: new Date().toISOString(),
        };
        this.groups.set(group_id, next);
        return next;
      },
    };
  }

  /**
   * Subscribe to event bus — call once during app bootstrap.
   */
  subscribe() {
    if (this._subscribed) return;
    this.eventBus.subscribe('role.invite.requested', async (event) => {
      return await this.createFromInvite(event.payload);
    });
    this._subscribed = true;
  }

  /**
   * Handler for 'role.invite.requested' event.
   * Creates approval group + notifies superadmin.
   */
  async createFromInvite(payload) {
    const {
      invitation_id,
      tenant_id,
      merchant_id,
      invitee_user_id,
      invitee_phone,
      role_code,
      invited_by,
      notify_room,
    } = payload;

    if (!invitation_id) throw new Error('invitation_id required in payload');

    const group_id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const group = {
      group_id,
      invitation_id,
      tenant_id,
      required_role: 'superadmin',  // spec #11: superadmin only
      notify_room: notify_room || 'ห้องรับใช้',
      min_approvals: this.config.min_approvals,
      status: 'open',
      created_at: new Date().toISOString(),
    };

    await this.store.saveGroup(group);

    // Notify superadmin (spec: never notify general admin)
    await this.notification.notifySuperadmin?.({
      room: group.notify_room,
      title: `[Approve Required] Role invite: ${invitee_user_id} → ${role_code}`,
      body: `Invitation ${invitation_id} awaits superadmin approval. Group: ${group_id}`,
      audience: 'superadmin',
      metadata: { group_id, invitation_id, role_code, tenant_id, invitee_user_id },
    });

    // Audit
    await this.audit.log?.({
      action: 'group.created',
      tenant_id,
      actor_user_id: 'system',
      actor_role: 'system',
      details: { group_id, invitation_id, required_role: 'superadmin' },
    });

    // Publish role.approval.opened event (for downstream subscribers / dashboards)
    await this.eventBus.publish('role.approval.opened', {
      group_id,
      invitation_id,
      tenant_id,
      role_code,
      required_role: 'superadmin',
      created_at: group.created_at,
    });

    return { group_id, status: 'open' };
  }

  /**
   * Cast a vote on an approval group.
   * Spec (#11): only superadmin role can vote.
   */
  async castVote({ group_id, voter_user_id, voter_role, decision, reason = null }) {
    // Spec rule: only superadmin
    if (voter_role !== 'superadmin') {
      throw new Error(`Only 'superadmin' role can vote on role invites. Got: ${voter_role}`);
    }

    const group = await this.store.findGroup(group_id);
    if (!group) throw new Error(`Group not found: ${group_id}`);
    if (group.status !== 'open') {
      throw new Error(`Group ${group_id} is ${group.status}, cannot accept votes`);
    }

    const vote = {
      vote_id: `vote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      group_id,
      voter_user_id,
      voter_role,
      decision,  // 'approve' | 'reject'
      reason,
      voted_at: new Date().toISOString(),
    };

    await this.store.saveVote(vote);

    // Audit
    await this.audit.log?.({
      action: 'vote.cast',
      tenant_id: group.tenant_id,
      actor_user_id: voter_user_id,
      actor_role: voter_role,
      details: { group_id, decision, reason },
    });

    // Check if group should close
    const counts = await this.store.countVotes(group_id);
    let closedDecision = null;
    if (counts.reject > 0) {
      closedDecision = 'rejected';
    } else if (counts.approve >= group.min_approvals) {
      closedDecision = 'approved';
    }

    if (closedDecision) {
      const closed = await this.store.closeGroup(group_id, closedDecision);
      // Publish invite.approved or invite.rejected
      const topic = closedDecision === 'approved' ? 'role.invite.approved' : 'role.invite.rejected';
      await this.eventBus.publish(topic, {
        invitation_id: group.invitation_id,
        group_id,
        decision: closedDecision,
        actor_user_id: voter_user_id,
      });
      await this.audit.log?.({
        action: `invite.${closedDecision}`,
        tenant_id: group.tenant_id,
        actor_user_id: voter_user_id,
        actor_role: voter_role,
        details: { invitation_id: group.invitation_id, group_id },
      });
      return { ...vote, group_status: 'closed', final_decision: closedDecision };
    }

    return { ...vote, group_status: 'open', votes_cast: counts.approve + counts.reject };
  }

  /**
   * List open approval groups (for superadmin dashboard).
   */
  async listOpenGroups() {
    return await this.store.findGroupsByStatus('open');
  }

  /**
   * Get vote summary for a group.
   */
  async getVoteSummary(group_id) {
    const group = await this.store.findGroup(group_id);
    if (!group) throw new Error(`Group not found: ${group_id}`);
    const counts = await this.store.countVotes(group_id);
    return {
      group_id,
      status: group.status,
      final_decision: group.final_decision,
      votes: counts,
      min_approvals: group.min_approvals,
      required_role: group.required_role,
    };
  }
}

module.exports = { RoleInviteEngine, ApprovalGroupEngine };