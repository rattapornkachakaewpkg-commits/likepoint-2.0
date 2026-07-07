-- ============================================================
-- Audit Log & Compliance — PF-5 (Phase D)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: PDPA-compliant audit log with 7-year retention + immutable + RLS
-- Related: PF-5 spec, fixes bugs A21, A31, A43, A44
-- ============================================================

BEGIN;

-- ============================================================
-- 1. audit_log — immutable, partitioned by year
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL,
  audit_id TEXT NOT NULL,                       -- AUD-{ts}-{seq}
  event_type TEXT NOT NULL,                     -- WALLET_CREDIT, MIGRATION, LOGIN, etc.
  actor TEXT NOT NULL,                          -- user:abc, service:wallet, system
  member_id UUID,                               -- nullable for system events
  member_hash TEXT,                             -- for PII-safe search
  resource_type TEXT,                           -- wallet, migration, session
  resource_id TEXT,
  action TEXT NOT NULL,                         -- CREATE, UPDATE, DELETE, READ
  outcome TEXT NOT NULL DEFAULT 'success',      -- success, failure, denied
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,  -- PII-stripped
  pii_encrypted BYTEA,                          -- AES-256-GCM encrypted PII
  correlation_id TEXT,                          -- cross-service trace
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retention_until TIMESTAMPTZ NOT NULL,         -- created_at + 7 years
  PRIMARY KEY (id, created_at)                  -- composite key for partitioning
) PARTITION BY RANGE (created_at);

-- ============================================================
-- Yearly partitions (2026-2033)
-- ============================================================
DO $$
DECLARE
  yr INT;
  start_date DATE;
  end_date DATE;
  partition_name TEXT;
BEGIN
  FOR yr IN 2026..2033 LOOP
    start_date := (yr || '-01-01')::DATE;
    end_date := ((yr + 1) || '-01-01')::DATE;
    partition_name := 'audit_log_y' || yr;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
  END LOOP;
END $$;

-- Indexes (per-partition)
CREATE INDEX IF NOT EXISTS idx_audit_member_hash ON audit_log (member_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_log (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_retention ON audit_log (retention_until);

-- ============================================================
-- 2. Immutability: trigger to reject UPDATE/DELETE
-- ============================================================
CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable: % is not allowed (PDPA compliance)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_log;
CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS trg_audit_no_delete ON audit_log;
CREATE TRIGGER trg_audit_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ============================================================
-- 3. pdpa_requests — tracks user data export requests (30-day SLA)
-- ============================================================
CREATE TABLE IF NOT EXISTS pdpa_requests (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,               -- PDPA-{ts}-{seq}
  member_id UUID NOT NULL,
  requested_by TEXT NOT NULL,                   -- self, admin:abc
  request_type TEXT NOT NULL DEFAULT 'data_export',
  status TEXT NOT NULL DEFAULT 'pending',       -- pending, ready, delivered, failed
  sla_deadline TIMESTAMPTZ NOT NULL,            -- now + 30 days
  export_id TEXT,
  delivered_at TIMESTAMPTZ,
  delivered_to TEXT,                            -- email or download URL
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdpa_member ON pdpa_requests (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdpa_sla ON pdpa_requests (sla_deadline) WHERE status NOT IN ('delivered', 'failed');
CREATE INDEX IF NOT EXISTS idx_pdpa_status ON pdpa_requests (status);

-- ============================================================
-- 4. export_jobs — tracks bulk exports (CSV/JSON)
-- ============================================================
CREATE TABLE IF NOT EXISTS export_jobs (
  id BIGSERIAL PRIMARY KEY,
  export_id TEXT UNIQUE NOT NULL,               -- EXP-{ts}-{seq}
  format TEXT NOT NULL,                         -- csv, json, pdpa_zip
  row_count INT NOT NULL DEFAULT 0,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by TEXT NOT NULL,
  storage_url TEXT,                             -- S3 path (signed URL in prod)
  size_bytes BIGINT,
  expires_at TIMESTAMPTZ NOT NULL,              -- 7 days
  downloaded_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_export_expires ON export_jobs (expires_at);
CREATE INDEX IF NOT EXISTS idx_export_requested ON export_jobs (requested_by, created_at DESC);

-- ============================================================
-- 5. View: v_audit_recent — for admin dashboard
-- ============================================================
CREATE OR REPLACE VIEW v_audit_recent AS
SELECT
  audit_id,
  event_type,
  actor,
  member_id,
  member_hash,
  resource_type,
  resource_id,
  action,
  outcome,
  correlation_id,
  created_at,
  retention_until,
  EXTRACT(DAY FROM (retention_until - now())) AS days_until_purge
FROM audit_log
ORDER BY created_at DESC
LIMIT 1000;

-- ============================================================
-- 6. View: v_pdpa_sla_status — for compliance team
-- ============================================================
CREATE OR REPLACE VIEW v_pdpa_sla_status AS
SELECT
  request_id,
  member_id,
  requested_by,
  status,
  sla_deadline,
  EXTRACT(DAY FROM (sla_deadline - now())) AS days_remaining,
  CASE
    WHEN status IN ('delivered', 'failed') THEN 'COMPLETED'
    WHEN now() > sla_deadline THEN 'BREACHED'
    WHEN EXTRACT(DAY FROM (sla_deadline - now())) <= 3 THEN 'AT_RISK'
    ELSE 'ON_TRACK'
  END AS sla_status,
  created_at
FROM pdpa_requests;

-- ============================================================
-- 7. RLS — 3 roles: admin (read+export), auditor (read), service (write)
-- ============================================================
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE pdpa_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;

-- audit_log
DROP POLICY IF EXISTS audit_admin_read ON audit_log;
CREATE POLICY audit_admin_read ON audit_log
  FOR SELECT
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS audit_auditor_read ON audit_log;
CREATE POLICY audit_auditor_read ON audit_log
  FOR SELECT
  USING (current_setting('app.current_role', true) = 'auditor');

DROP POLICY IF EXISTS audit_service_write ON audit_log;
CREATE POLICY audit_service_write ON audit_log
  FOR INSERT
  WITH CHECK (current_setting('app.current_role', true) = 'service');

-- pdpa_requests
DROP POLICY IF EXISTS pdpa_admin_all ON pdpa_requests;
CREATE POLICY pdpa_admin_all ON pdpa_requests
  FOR ALL
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS pdpa_service_write ON pdpa_requests;
CREATE POLICY pdpa_service_write ON pdpa_requests
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- export_jobs
DROP POLICY IF EXISTS export_admin_read ON export_jobs;
CREATE POLICY export_admin_read ON export_jobs
  FOR ALL
  USING (current_setting('app.current_role', true) IN ('admin', 'auditor'));

DROP POLICY IF EXISTS export_service_write ON export_jobs;
CREATE POLICY export_service_write ON export_jobs
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 8. Function: archive_old_audit() — runs daily
-- ============================================================
CREATE OR REPLACE FUNCTION archive_old_audit(p_cutoff_years INT DEFAULT 7)
RETURNS TABLE (
  archived_count BIGINT,
  cutoff_date TIMESTAMPTZ
) AS $$
DECLARE
  v_cutoff TIMESTAMPTZ;
  v_count BIGINT;
BEGIN
  v_cutoff := now() - (p_cutoff_years || ' years')::INTERVAL;

  -- In production: move to S3 glacier via aws_s3 extension
  -- For prototype: just count what would be archived
  SELECT COUNT(*) INTO v_count
  FROM audit_log
  WHERE created_at < v_cutoff;

  RETURN QUERY SELECT v_count, v_cutoff;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 9. Function: get_audit_stats(p_since)
-- ============================================================
CREATE OR REPLACE FUNCTION get_audit_stats(p_since TIMESTAMPTZ DEFAULT now() - INTERVAL '7 days')
RETURNS TABLE (
  total_entries BIGINT,
  unique_actors BIGINT,
  unique_members BIGINT,
  failure_count BIGINT,
  pdpa_requests BIGINT,
  export_jobs BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM audit_log WHERE created_at >= p_since) AS total_entries,
    (SELECT COUNT(DISTINCT actor) FROM audit_log WHERE created_at >= p_since) AS unique_actors,
    (SELECT COUNT(DISTINCT member_id) FROM audit_log WHERE created_at >= p_since) AS unique_members,
    (SELECT COUNT(*) FROM audit_log WHERE created_at >= p_since AND outcome = 'failure') AS failure_count,
    (SELECT COUNT(*) FROM pdpa_requests WHERE created_at >= p_since) AS pdpa_requests,
    (SELECT COUNT(*) FROM export_jobs WHERE created_at >= p_since) AS export_jobs;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_audit_recent LIMIT 10;
-- SELECT * FROM v_pdpa_sla_status WHERE sla_status IN ('AT_RISK', 'BREACHED');
-- SELECT * FROM get_audit_stats(now() - INTERVAL '24 hours');
-- SELECT * FROM archive_old_audit(7);
-- ============================================================
