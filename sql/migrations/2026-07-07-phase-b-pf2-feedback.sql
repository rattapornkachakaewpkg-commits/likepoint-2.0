-- ===========================================
-- Phase B: PF-2 Enhanced — Bug Fixes for User Feedback
-- Date: 2026-07-07
-- Author: AliClaw (AI Co-Worker)
-- Branch: feature/phase-b-pf2-feedback
-- Bug Refs: A2, A10, A11, A14, A20 (from user feedback dump)
-- ===========================================

-- ===========================================
-- 1. Wallet Reconciliation Log (A2/A10/A11 heal trail)
-- ===========================================
CREATE TABLE IF NOT EXISTS wallet_reconcile_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id         UUID NOT NULL,
  person_id         UUID NOT NULL,
  reconcile_type    VARCHAR(30) NOT NULL,  -- 'BALANCE_HEAL' | 'AAMPOINT_HEAL' | 'PHONE_REBIND' | 'NEGATIVE_BLOCK'
  bug_ref           VARCHAR(10),           -- 'A2', 'A10', 'A11', 'A14', 'A20'
  old_value         JSONB,
  new_value         JSONB,
  source            VARCHAR(50),           -- 'wallet_reconcile_engine' | 'admin_manual'
  triggered_by      VARCHAR(50),           -- 'system' | 'admin_user_id' | 'user_request'
  metadata          JSONB,
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconcile_wallet
  ON wallet_reconcile_log(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconcile_person
  ON wallet_reconcile_log(person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconcile_type
  ON wallet_reconcile_log(reconcile_type)
  WHERE reconcile_type IN ('BALANCE_HEAL', 'AAMPOINT_HEAL', 'NEGATIVE_BLOCK');

-- ===========================================
-- 2. Ghost Wallet Detector View (A2 — find zero/null balances)
-- ===========================================
CREATE OR REPLACE VIEW v_ghost_wallets AS
SELECT
  w.wallet_id,
  w.person_id,
  w.tenant_id,
  w.balance,
  w.phone_hash,
  w.status,
  w.last_reconciled_at,
  -- Suspect if: balance=0/null but has recent ledger activity
  (SELECT COUNT(*) FROM point_transactions pt
   WHERE pt.wallet_id = w.wallet_id
     AND pt.created_at > NOW() - INTERVAL '7 days') AS recent_txn_count,
  CASE
    WHEN w.balance IS NULL THEN 'NULL_BALANCE'
    WHEN w.balance = 0 THEN 'ZERO_BALANCE'
    WHEN w.balance < 0 THEN 'NEGATIVE_BALANCE'
    ELSE 'HEALTHY'
  END AS issue_type
FROM mini_like_wallets w
WHERE w.status = 'ACTIVE'
  AND (w.balance IS NULL OR w.balance <= 0);

-- ===========================================
-- 3. AAMpoint Sync State (A14 — cross-tenant reconciliation)
-- ===========================================
CREATE TABLE IF NOT EXISTS aampoint_sync_state (
  member_id         UUID PRIMARY KEY,
  aam_ledger_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
  wallet_cached_balance DECIMAL(18,2),
  last_sync_at      TIMESTAMP DEFAULT NOW(),
  last_heal_at      TIMESTAMP,
  heal_count        INTEGER DEFAULT 0,
  sync_status       VARCHAR(20) DEFAULT 'IN_SYNC',  -- 'IN_SYNC' | 'OUT_OF_SYNC' | 'HEALED' | 'FAILED'
  last_error        TEXT,
  UNIQUE(member_id)
);

CREATE INDEX IF NOT EXISTS idx_aam_sync_status
  ON aampoint_sync_state(sync_status)
  WHERE sync_status != 'IN_SYNC';

-- ===========================================
-- 4. Negative Balance Alert Queue (A11)
-- ===========================================
CREATE TABLE IF NOT EXISTS negative_balance_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id         UUID NOT NULL,
  person_id         UUID NOT NULL,
  balance           DECIMAL(18,2) NOT NULL,
  severity          VARCHAR(10) DEFAULT 'HIGH',  -- 'HIGH' | 'CRITICAL'
  status            VARCHAR(20) DEFAULT 'PENDING',  -- 'PENDING' | 'INVESTIGATING' | 'RESOLVED' | 'IGNORED'
  assigned_to       UUID,
  resolved_at       TIMESTAMP,
  resolution_note   TEXT,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_neg_alerts_pending
  ON negative_balance_alerts(status, severity, created_at)
  WHERE status = 'PENDING';

-- ===========================================
-- 5. Statement Cache (A20 — statement performance)
-- ===========================================
CREATE TABLE IF NOT EXISTS statement_cache (
  wallet_id         UUID NOT NULL,
  cache_key         VARCHAR(100) NOT NULL,    -- hash of (start|end|limit|offset)
  start_date        TIMESTAMP,
  end_date          TIMESTAMP,
  entries           JSONB NOT NULL,
  total_count       INTEGER NOT NULL,
  has_more          BOOLEAN DEFAULT false,
  generated_at      TIMESTAMP DEFAULT NOW(),
  expires_at        TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes',
  PRIMARY KEY (wallet_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_stmt_cache_expires
  ON statement_cache(expires_at);

-- ===========================================
-- 6. Scheduled reconcile job (cron-friendly function)
-- ===========================================
CREATE OR REPLACE FUNCTION run_wallet_reconcile(p_person_id UUID)
RETURNS TABLE(wallet_id UUID, issue_type TEXT, current_balance DECIMAL, suggestion TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.wallet_id,
    CASE
      WHEN w.balance IS NULL THEN 'NULL_BALANCE'::TEXT
      WHEN w.balance < 0 THEN 'NEGATIVE_BALANCE'::TEXT
      WHEN w.balance = 0 THEN 'ZERO_BALANCE'::TEXT
      ELSE 'HEALTHY'::TEXT
    END AS issue_type,
    COALESCE(w.balance, 0) AS current_balance,
    CASE
      WHEN w.balance < 0 THEN 'Manual review — block transfers'::TEXT
      WHEN w.balance IS NULL THEN 'Run getBalance() to heal from ledger'::TEXT
      WHEN w.balance = 0 THEN 'Verify with ledger — possible heal needed'::TEXT
      ELSE 'No action'::TEXT
    END AS suggestion
  FROM mini_like_wallets w
  WHERE w.person_id = p_person_id
    AND w.status = 'ACTIVE';
END;
$$ LANGUAGE plpgsql;

-- ===========================================
-- 7. Sample seed data for demo page
-- ===========================================
-- (Demo only — production uses real data)
-- These match the test cases in wallet-rebind-fixes.test.js
COMMENT ON TABLE wallet_reconcile_log IS
'Phase B: PF-2 reconciliation audit trail. References bug fixes A2/A10/A11/A14/A20 from user feedback 2026-07-07.';

COMMENT ON VIEW v_ghost_wallets IS
'Phase B: PF-2 — surface wallets with null/zero/negative balance for self-heal. Bug A2/A10/A11.';

COMMENT ON TABLE aampoint_sync_state IS
'Phase B: PF-2 — cross-tenant AAMpoint reconciliation state. Bug A14 (AAMpoint not in wallet).';

COMMENT ON TABLE negative_balance_alerts IS
'Phase B: PF-2 — admin alert queue for negative wallet balances. Bug A11.';

COMMENT ON TABLE statement_cache IS
'Phase B: PF-2 — short-lived statement cache to fix A20 (statement not showing).';
