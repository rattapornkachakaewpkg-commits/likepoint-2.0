-- ============================================================
-- AAM Migration — PF-1 (Phase C)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Persist AAM → LP2.0 migration state with idempotency
-- Related: PF-1 spec, fixes bugs A14 (AAMpoint missing), A42 (cross-tenant)
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. aam_migration_records: per-account migration tracking
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aam_migration_records (
  id BIGSERIAL PRIMARY KEY,
  claim_id TEXT UNIQUE NOT NULL,                       -- AAM-MIG-{aam_account_id}-{ts}
  aam_account_id TEXT NOT NULL,                        -- legacy AAM account
  member_id UUID NOT NULL,                             -- target LP2.0 member
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),   -- migrated points
  phone_hash TEXT NOT NULL,                            -- for cross-tenant join
  credit_txn_id TEXT,                                  -- LP2.0 credit transaction
  actor TEXT NOT NULL DEFAULT 'system',
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolled_back_at TIMESTAMPTZ,
  rollback_reason TEXT,
  rollback_actor TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aam_mig_claim_id ON aam_migration_records (claim_id);
CREATE INDEX IF NOT EXISTS idx_aam_mig_aam_account ON aam_migration_records (aam_account_id);
CREATE INDEX IF NOT EXISTS idx_aam_mig_member ON aam_migration_records (member_id);
CREATE INDEX IF NOT EXISTS idx_aam_mig_rolled_back ON aam_migration_records (rolled_back_at) WHERE rolled_back_at IS NOT NULL;

-- ------------------------------------------------------------
-- 2. aam_migration_batches: track batch runs
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aam_migration_batches (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT UNIQUE NOT NULL,                       -- AAM-BATCH-{ts}
  total INT NOT NULL,
  migrated INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  actor TEXT NOT NULL DEFAULT 'system',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_aam_batch_started ON aam_migration_batches (started_at DESC);

-- ------------------------------------------------------------
-- 3. aam_legacy_accounts: track legacy AAM side
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aam_legacy_accounts (
  id BIGSERIAL PRIMARY KEY,
  aam_account_id TEXT UNIQUE NOT NULL,
  phone_hash TEXT NOT NULL,
  original_balance NUMERIC(18,2) NOT NULL,
  migrated BOOLEAN NOT NULL DEFAULT false,
  migration_claim_id TEXT REFERENCES aam_migration_records(claim_id),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aam_legacy_phone ON aam_legacy_accounts (phone_hash);
CREATE INDEX IF NOT EXISTS idx_aam_legacy_migrated ON aam_legacy_accounts (migrated) WHERE NOT migrated;

-- ------------------------------------------------------------
-- 4. View: v_aam_migration_status (admin dashboard)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_aam_migration_status AS
SELECT
  r.claim_id,
  r.aam_account_id,
  r.member_id,
  r.amount,
  r.phone_hash,
  r.credit_txn_id,
  r.migrated_at,
  r.rolled_back_at,
  r.rollback_reason,
  CASE
    WHEN r.rolled_back_at IS NOT NULL THEN 'ROLLED_BACK'
    ELSE 'MIGRATED'
  END AS status,
  EXTRACT(EPOCH FROM (now() - r.migrated_at)) AS seconds_since_migration
FROM aam_migration_records r
ORDER BY r.migrated_at DESC;

-- ------------------------------------------------------------
-- 5. Function: get_aam_migration_summary()
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_aam_migration_summary(p_since TIMESTAMPTZ DEFAULT now() - INTERVAL '7 days')
RETURNS TABLE (
  total_migrated BIGINT,
  total_rolled_back BIGINT,
  total_points_migrated NUMERIC,
  unique_members BIGINT,
  oldest_migration TIMESTAMPTZ,
  newest_migration TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE rolled_back_at IS NULL) AS total_migrated,
    COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS total_rolled_back,
    COALESCE(SUM(amount) FILTER (WHERE rolled_back_at IS NULL), 0) AS total_points_migrated,
    COUNT(DISTINCT member_id) FILTER (WHERE rolled_back_at IS NULL) AS unique_members,
    MIN(migrated_at) FILTER (WHERE rolled_back_at IS NULL) AS oldest_migration,
    MAX(migrated_at) FILTER (WHERE rolled_back_at IS NULL) AS newest_migration
  FROM aam_migration_records
  WHERE migrated_at >= p_since;
END;
$$ LANGUAGE plpgsql STABLE;

-- ------------------------------------------------------------
-- 6. RLS: only admin role can read migration records
-- ------------------------------------------------------------
ALTER TABLE aam_migration_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aam_mig_admin_read ON aam_migration_records;
CREATE POLICY aam_mig_admin_read ON aam_migration_records
  FOR SELECT
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS aam_mig_service_all ON aam_migration_records;
CREATE POLICY aam_mig_service_all ON aam_migration_records
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- ------------------------------------------------------------
-- 7. Seed example (for dashboard demo only — comment out in prod)
-- ------------------------------------------------------------
-- INSERT INTO aam_legacy_accounts (aam_account_id, phone_hash, original_balance) VALUES
--   ('AAM-DEMO-001', 'ph_demo_aaa', 500),
--   ('AAM-DEMO-002', 'ph_demo_bbb', 1200)
-- ON CONFLICT DO NOTHING;

COMMIT;

-- ============================================================
-- Post-migration check:
-- SELECT * FROM get_aam_migration_summary();
-- SELECT * FROM v_aam_migration_status LIMIT 10;
-- ============================================================
