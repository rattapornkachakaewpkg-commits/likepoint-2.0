-- ============================================================
-- Phase F: PF-23 Role/Approval Engine
-- ============================================================
-- Implements:
--   - role_invitations (invite user → role, awaiting approval)
--   - role_approval_groups (approval group for superadmin)
--   - role_approval_votes (superadmin vote approve/reject)
--   - role_assignment_audit (audit trail for governance)
--
-- Business Rules (from วิชัย(ขวัญ) feedback 2026-08-14):
--   - Invite flow MUST create approval group + notify superadmin
--   - Request to join group: ONLY via merchant_admin_console
--   - Approver audience: ONLY superadmin role
--   - Admin role CANNOT see/approve role invites
--
-- Resolves LP-FEED-2026-08-14 issues:
--   - #10: Invite ไม่สร้างกลุ่ม approve (workflow bug)
--   - #11: Spec — approve scope (superadmin only, MAC only)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Roles reference table
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  role_code        TEXT PRIMARY KEY,           -- 'superadmin', 'admin', 'merchant_admin', 'viewer'
  role_name_th     TEXT NOT NULL,
  role_name_en     TEXT NOT NULL,
  can_approve_role BOOLEAN NOT NULL DEFAULT false,
  can_invite_role  BOOLEAN NOT NULL DEFAULT false,
  scope            TEXT NOT NULL DEFAULT 'tenant',  -- 'system' | 'tenant' | 'merchant'
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Seed roles
INSERT INTO roles (role_code, role_name_th, role_name_en, can_approve_role, can_invite_role, scope) VALUES
  ('superadmin',     'Super Admin',     'Super Admin',     true,  true,  'system'),
  ('admin',          'Admin ทั่วไป',    'General Admin',   false, false, 'tenant'),
  ('merchant_admin', 'Merchant Admin',  'Merchant Admin',  false, true,  'merchant'),
  ('viewer',         'Viewer',          'Viewer',          false, false, 'tenant')
ON CONFLICT (role_code) DO NOTHING;

-- ============================================================
-- 2. Role Invitations (invite user → role, awaiting approval)
-- ============================================================
CREATE TABLE IF NOT EXISTS role_invitations (
  invitation_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL,
  merchant_id        TEXT,                     -- NULL = tenant-level
  invitee_user_id    TEXT NOT NULL,
  invitee_phone      TEXT NOT NULL,
  role_code          TEXT NOT NULL REFERENCES roles(role_code),
  invited_by         TEXT NOT NULL,           -- inviter user_id
  source_console     TEXT NOT NULL DEFAULT 'merchant_admin_console',
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  approval_group_id  UUID,                     -- FK to role_approval_groups (NULL until created)
  invite_payload     JSONB NOT NULL DEFAULT '{}',
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at         TIMESTAMPTZ,
  decided_by         TEXT
);

CREATE INDEX idx_role_invitations_status ON role_invitations (status, created_at DESC);
CREATE INDEX idx_role_invitations_invitee ON role_invitations (invitee_user_id, status);
CREATE INDEX idx_role_invitations_group ON role_invitations (approval_group_id) WHERE approval_group_id IS NOT NULL;

-- ============================================================
-- 3. Approval Groups (one group per pending invite)
-- ============================================================
CREATE TABLE IF NOT EXISTS role_approval_groups (
  group_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id     UUID NOT NULL REFERENCES role_invitations(invitation_id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL,
  required_role     TEXT NOT NULL DEFAULT 'superadmin',  -- spec: superadmin only
  notify_room       TEXT,                                -- 'ห้องรับใช้' or 'pkg_support'
  min_approvals     INT NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'closed', 'expired')),
  closed_at         TIMESTAMPTZ,
  final_decision    TEXT CHECK (final_decision IN ('approved', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_approval_groups_status ON role_approval_groups (status, created_at DESC);
CREATE INDEX idx_approval_groups_invitation ON role_approval_groups (invitation_id);

-- ============================================================
-- 4. Approval Votes (superadmin approve/reject)
-- ============================================================
CREATE TABLE IF NOT EXISTS role_approval_votes (
  vote_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          UUID NOT NULL REFERENCES role_approval_groups(group_id) ON DELETE CASCADE,
  voter_user_id     TEXT NOT NULL,
  voter_role        TEXT NOT NULL,            -- must be 'superadmin'
  decision          TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason            TEXT,
  voted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, voter_user_id)             -- 1 vote per approver per group
);

CREATE INDEX idx_approval_votes_group ON role_approval_votes (group_id);

-- ============================================================
-- 5. Audit Trail (governance)
-- ============================================================
CREATE TABLE IF NOT EXISTS role_assignment_audit (
  audit_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL,
  invitation_id     UUID,
  group_id          UUID,
  action            TEXT NOT NULL,            -- 'invite.created', 'group.created', 'vote.cast', 'invite.approved', 'invite.rejected'
  actor_user_id     TEXT NOT NULL,
  actor_role        TEXT NOT NULL,
  details           JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_role_audit_invitation ON role_assignment_audit (invitation_id, created_at DESC);
CREATE INDEX idx_role_audit_tenant_time ON role_assignment_audit (tenant_id, created_at DESC);

-- ============================================================
-- 6. Views
-- ============================================================

-- v_role_invitations_full: join invitations + groups + roles for UI
CREATE OR REPLACE VIEW v_role_invitations_full AS
SELECT
  i.invitation_id,
  i.tenant_id,
  i.merchant_id,
  i.invitee_user_id,
  i.invitee_phone,
  i.role_code,
  r.role_name_th,
  r.role_name_en,
  i.invited_by,
  i.source_console,
  i.status,
  i.approval_group_id,
  g.status AS group_status,
  g.min_approvals,
  g.final_decision,
  i.invite_payload,
  i.expires_at,
  i.created_at,
  i.decided_at,
  i.decided_by
FROM role_invitations i
LEFT JOIN roles r ON r.role_code = i.role_code
LEFT JOIN role_approval_groups g ON g.group_id = i.approval_group_id;

-- v_pending_approvals_for_superadmin: dashboard for superadmin
CREATE OR REPLACE VIEW v_pending_approvals_for_superadmin AS
SELECT
  g.group_id,
  g.invitation_id,
  i.tenant_id,
  i.merchant_id,
  i.invitee_user_id,
  i.invitee_phone,
  i.role_code,
  r.role_name_th,
  i.invited_by,
  g.created_at AS group_created_at,
  i.expires_at,
  COUNT(v.vote_id) AS votes_cast
FROM role_approval_groups g
JOIN role_invitations i ON i.invitation_id = g.invitation_id
JOIN roles r ON r.role_code = i.role_code
LEFT JOIN role_approval_votes v ON v.group_id = g.group_id
WHERE g.status = 'open' AND i.status = 'pending'
GROUP BY g.group_id, i.invitation_id, i.tenant_id, i.merchant_id,
         i.invitee_user_id, i.invitee_phone, i.role_code, r.role_name_th,
         i.invited_by, g.created_at, i.expires_at;

-- ============================================================
-- 7. RLS Policies (Security: spec rules)
-- ============================================================

ALTER TABLE role_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_approval_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_approval_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignment_audit ENABLE ROW LEVEL SECURITY;

-- RLS: approve_role_invite → only superadmin
CREATE POLICY "approve_role_invite_superadmin_only" ON role_approval_votes
  FOR INSERT
  WITH CHECK (
    voter_role = 'superadmin'
  );

-- RLS: create_role_invite → only merchant_admin_console source
CREATE POLICY "invite_via_merchant_console_only" ON role_invitations
  FOR INSERT
  WITH CHECK (
    source_console = 'merchant_admin_console'
    AND invited_by IS NOT NULL
  );

-- RLS: view_role_invites → superadmin can see all, others see only own tenant
CREATE POLICY "view_role_invites_scoped" ON role_invitations
  FOR SELECT
  USING (
    -- (assume app sets app.current_user_role and app.current_tenant_id)
    current_setting('app.current_user_role', true) = 'superadmin'
    OR tenant_id = current_setting('app.current_tenant_id', true)
  );

-- ============================================================
-- 8. Helper function: close approval group after votes
-- ============================================================
CREATE OR REPLACE FUNCTION close_approval_group_if_done(p_group_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_min INT;
  v_approves INT;
  v_rejects INT;
  v_status TEXT;
BEGIN
  SELECT min_approvals, status INTO v_min, v_status
  FROM role_approval_groups WHERE group_id = p_group_id;

  IF v_status != 'open' THEN RETURN v_status; END IF;

  SELECT
    COUNT(*) FILTER (WHERE decision = 'approve'),
    COUNT(*) FILTER (WHERE decision = 'reject')
  INTO v_approves, v_rejects
  FROM role_approval_votes WHERE group_id = p_group_id;

  IF v_rejects > 0 THEN
    UPDATE role_approval_groups
    SET status = 'closed', final_decision = 'rejected', closed_at = now()
    WHERE group_id = p_group_id;
    UPDATE role_invitations
    SET status = 'rejected', decided_at = now()
    WHERE invitation_id = (SELECT invitation_id FROM role_approval_groups WHERE group_id = p_group_id);
    RETURN 'rejected';
  END IF;

  IF v_approves >= v_min THEN
    UPDATE role_approval_groups
    SET status = 'closed', final_decision = 'approved', closed_at = now()
    WHERE group_id = p_group_id;
    UPDATE role_invitations
    SET status = 'approved', decided_at = now()
    WHERE invitation_id = (SELECT invitation_id FROM role_approval_groups WHERE group_id = p_group_id);
    RETURN 'approved';
  END IF;

  RETURN 'still_open';
END;
$$ LANGUAGE plpgsql;

COMMIT;