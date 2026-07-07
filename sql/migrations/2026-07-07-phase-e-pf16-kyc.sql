-- ============================================================
-- KYC Engine — PF-16 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: KYC Level 2/3 manual review — application queue + documents + reviewers
-- Based on Constitution v0.2: "LEVEL_2 (manual review)"
-- ============================================================

BEGIN;

-- ============================================================
-- 1. kyc_reviewers
-- ============================================================
CREATE TABLE IF NOT EXISTS kyc_reviewers (
  id BIGSERIAL PRIMARY KEY,
  reviewer_id TEXT UNIQUE NOT NULL,                  -- R-1, R-2, etc.
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  specializations JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['business', 'tax', 'banking']
  active BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active',              -- active | suspended | inactive
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_assigned_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reviewer_active ON kyc_reviewers (active) WHERE active = true;

-- ============================================================
-- 2. kyc_applications
-- ============================================================
CREATE TABLE IF NOT EXISTS kyc_applications (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT UNIQUE NOT NULL,              -- KYC-{ts}-{seq}
  member_id UUID NOT NULL,
  level INT NOT NULL CHECK (level IN (2, 3)),
  business_name TEXT,
  business_license TEXT,
  tax_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | in_review | more_info_required | approved | rejected
  assigned_reviewer_id TEXT REFERENCES kyc_reviewers(reviewer_id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sla_deadline TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  decision TEXT,                                    -- approved | rejected
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kyc_member ON kyc_applications (member_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_applications (status);
CREATE INDEX IF NOT EXISTS idx_kyc_reviewer ON kyc_applications (assigned_reviewer_id) WHERE assigned_reviewer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_sla ON kyc_applications (sla_deadline) WHERE status IN ('pending', 'in_review');
CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_member_level_pending ON kyc_applications (member_id, level) WHERE status IN ('pending', 'in_review', 'more_info_required');

-- ============================================================
-- 3. kyc_documents
-- ============================================================
CREATE TABLE IF NOT EXISTS kyc_documents (
  id BIGSERIAL PRIMARY KEY,
  document_id TEXT UNIQUE NOT NULL,                   -- DOC-{ts}-{seq}
  application_id TEXT NOT NULL REFERENCES kyc_applications(application_id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,                       -- business_license, tax_id, id_card, bank_statement
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size_bytes BIGINT,
  mime_type TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_kycdoc_app ON kyc_documents (application_id);

-- ============================================================
-- 4. kyc_reviews — review history
-- ============================================================
CREATE TABLE IF NOT EXISTS kyc_reviews (
  id BIGSERIAL PRIMARY KEY,
  review_id TEXT UNIQUE NOT NULL,                    -- REV-{ts}-{seq}
  application_id TEXT NOT NULL REFERENCES kyc_applications(application_id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES kyc_reviewers(reviewer_id),
  decision TEXT NOT NULL,                            -- approved | rejected | more_info_required
  notes TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kycrev_app ON kyc_reviews (application_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_kycrev_reviewer ON kyc_reviews (reviewer_id, reviewed_at DESC);

-- ============================================================
-- 5. View: v_kyc_pending_queue
-- ============================================================
CREATE OR REPLACE VIEW v_kyc_pending_queue AS
SELECT
  a.application_id,
  a.member_id,
  a.level,
  a.business_name,
  a.status,
  a.assigned_reviewer_id,
  a.submitted_at,
  a.sla_deadline,
  EXTRACT(EPOCH FROM (a.sla_deadline - now())) / 3600 AS hours_until_sla,
  CASE
    WHEN a.sla_deadline < now() THEN 'BREACHED'
    WHEN EXTRACT(EPOCH FROM (a.sla_deadline - now())) / 3600 < 6 THEN 'URGENT'
    WHEN EXTRACT(EPOCH FROM (a.sla_deadline - now())) / 3600 < 24 THEN 'WARNING'
    ELSE 'NORMAL'
  END AS sla_status,
  COUNT(d.document_id) AS document_count
FROM kyc_applications a
LEFT JOIN kyc_documents d ON d.application_id = a.application_id
WHERE a.status IN ('pending', 'in_review', 'more_info_required')
GROUP BY a.application_id, a.member_id, a.level, a.business_name, a.status, a.assigned_reviewer_id, a.submitted_at, a.sla_deadline;

-- ============================================================
-- 6. RLS
-- ============================================================
ALTER TABLE kyc_reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_reviews ENABLE ROW LEVEL SECURITY;

-- applications: member own, reviewer assigned, admin all
DROP POLICY IF EXISTS kyc_app_own ON kyc_applications;
CREATE POLICY kyc_app_own ON kyc_applications
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'member'
    AND member_id::text = current_setting('app.current_member_id', true)
  );

DROP POLICY IF EXISTS kyc_app_reviewer ON kyc_applications;
CREATE POLICY kyc_app_reviewer ON kyc_applications
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'reviewer'
    AND assigned_reviewer_id = current_setting('app.current_reviewer_id', true)
  );

DROP POLICY IF EXISTS kyc_app_admin ON kyc_applications;
CREATE POLICY kyc_app_admin ON kyc_applications
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS kyc_app_service ON kyc_applications;
CREATE POLICY kyc_app_service ON kyc_applications
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- documents: same as applications
DROP POLICY IF EXISTS kyc_doc_own ON kyc_documents;
CREATE POLICY kyc_doc_own ON kyc_documents
  FOR SELECT
  USING (
    application_id IN (SELECT application_id FROM kyc_applications WHERE member_id::text = current_setting('app.current_member_id', true))
  );

DROP POLICY IF EXISTS kyc_doc_reviewer ON kyc_documents;
CREATE POLICY kyc_doc_reviewer ON kyc_documents
  FOR SELECT
  USING (
    application_id IN (SELECT application_id FROM kyc_applications WHERE assigned_reviewer_id = current_setting('app.current_reviewer_id', true))
  );

DROP POLICY IF EXISTS kyc_doc_admin ON kyc_documents;
CREATE POLICY kyc_doc_admin ON kyc_documents
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS kyc_doc_service ON kyc_documents;
CREATE POLICY kyc_doc_service ON kyc_documents
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 7. Function: get_kyc_stats(p_since)
-- ============================================================
CREATE OR REPLACE FUNCTION get_kyc_stats(p_since TIMESTAMPTZ DEFAULT now() - INTERVAL '7 days')
RETURNS TABLE (
  total_applications BIGINT,
  pending BIGINT,
  approved BIGINT,
  rejected BIGINT,
  more_info BIGINT,
  sla_breaches BIGINT,
  approval_rate NUMERIC
) AS $$
DECLARE
  v_total BIGINT;
  v_pending BIGINT;
  v_approved BIGINT;
  v_rejected BIGINT;
  v_more BIGINT;
  v_breaches BIGINT;
BEGIN
  SELECT COUNT(*),
    COUNT(*) FILTER (WHERE status IN ('pending', 'in_review')),
    COUNT(*) FILTER (WHERE status = 'approved'),
    COUNT(*) FILTER (WHERE status = 'rejected'),
    COUNT(*) FILTER (WHERE status = 'more_info_required'),
    COUNT(*) FILTER (WHERE status IN ('pending', 'in_review') AND sla_deadline < now())
  INTO v_total, v_pending, v_approved, v_rejected, v_more, v_breaches
  FROM kyc_applications WHERE submitted_at >= p_since;
  RETURN QUERY SELECT v_total, v_pending, v_approved, v_rejected, v_more, v_breaches,
    CASE WHEN (v_approved + v_rejected) > 0 THEN ROUND(v_approved::NUMERIC / (v_approved + v_rejected) * 100, 1) ELSE 0 END;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_kyc_pending_queue ORDER BY sla_deadline LIMIT 10;
-- SELECT * FROM get_kyc_stats(now() - INTERVAL '7 days');
-- ============================================================
