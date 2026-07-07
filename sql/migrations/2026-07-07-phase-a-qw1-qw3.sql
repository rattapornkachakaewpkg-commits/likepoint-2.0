-- ===========================================
-- Phase A: Quick Win (QW-1, QW-2, QW-3)
-- Date: 2026-07-07
-- Author: AliClaw (AI Co-Worker)
-- Branch: feature/phase-a-qw1-qw2
-- ===========================================

-- ===========================================
-- QW-1: Risk-based BCT Distribution
-- Add columns to msp_transaction for risk tier + audit
-- ===========================================

-- PostgreSQL syntax (use IF NOT EXISTS where supported)
ALTER TABLE msp_transaction
  ADD COLUMN IF NOT EXISTS person_id_snapshot VARCHAR(50),
  ADD COLUMN IF NOT EXISTS risk_level VARCHAR(10),  -- 'LOW' | 'MEDIUM' | 'HIGH'
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS wallet_status_at_txn VARCHAR(20);  -- 'ACTIVE' | 'LOCKED' | 'MISSING'

-- Index for fast lookup by risk level
CREATE INDEX IF NOT EXISTS idx_msp_txn_risk_level 
  ON msp_transaction(risk_level) 
  WHERE risk_level IN ('MEDIUM', 'HIGH');

CREATE INDEX IF NOT EXISTS idx_msp_txn_person_snapshot 
  ON msp_transaction(person_id_snapshot);

-- ===========================================
-- QW-3: BCT Hold Queue
-- Hold high-risk BCT until permanent fix is ready
-- ===========================================

CREATE TABLE IF NOT EXISTS bct_hold_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     UUID NOT NULL,
  amount        DECIMAL(18,2) NOT NULL,
  currency      VARCHAR(10) DEFAULT 'BUPOINT',  -- 'BUPOINT' | 'THB' | 'LAK' | 'USD'
  reason        TEXT,
  risk_level    VARCHAR(10) NOT NULL,
  wallet_id     UUID,  -- old wallet (lost)
  new_wallet_id UUID,  -- new wallet (active)
  hold_at       TIMESTAMP DEFAULT NOW(),
  release_at    TIMESTAMP,  -- when permanent fix is ready
  status        VARCHAR(20) DEFAULT 'HELD',  -- HELD | RELEASED | CANCELLED
  released_at   TIMESTAMP,
  notification_sent BOOLEAN DEFAULT false,
  notes         TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bct_hold_status ON bct_hold_queue(status);
CREATE INDEX IF NOT EXISTS idx_bct_hold_member ON bct_hold_queue(member_id);
CREATE INDEX IF NOT EXISTS idx_bct_hold_release ON bct_hold_queue(release_at) WHERE status = 'HELD';

-- ===========================================
-- QW-1 Support Table: Wallet Status Log
-- Track every wallet state change for audit + recovery
-- ===========================================

CREATE TABLE IF NOT EXISTS wallet_status_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     UUID NOT NULL,
  member_id     UUID NOT NULL,
  person_id     UUID,
  old_status    VARCHAR(20),
  new_status    VARCHAR(20),  -- 'ACTIVE' | 'LOCKED' | 'MERGED' | 'MISSING'
  reason        TEXT,
  triggered_by  VARCHAR(20),  -- 'SYSTEM' | 'ADMIN' | 'API'
  actor_id      UUID,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_status_wallet ON wallet_status_log(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_status_member ON wallet_status_log(member_id);

-- ===========================================
-- Audit Log Extension (PDPA + Compliance)
-- ===========================================

CREATE TABLE IF NOT EXISTS recovery_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action        VARCHAR(50) NOT NULL,  -- 'MSP_RECOVERY' | 'BCT_HOLD' | 'BCT_RELEASE'
  member_id     UUID,
  person_id     UUID,
  admin_id      UUID,
  old_wallet_id UUID,
  new_wallet_id UUID,
  amount        DECIMAL(18,2),
  reason        TEXT,
  notes         TEXT,
  consent_ref   VARCHAR(100),  -- PDPA consent reference
  totp_verified BOOLEAN DEFAULT false,
  ip_address    VARCHAR(45),
  user_agent    TEXT,
  status        VARCHAR(20),  -- 'SUCCESS' | 'FAILED' | 'REVERSED'
  reversed_at   TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recovery_audit_member ON recovery_audit(member_id);
CREATE INDEX IF NOT EXISTS idx_recovery_audit_admin ON recovery_audit(admin_id);
CREATE INDEX IF NOT EXISTS idx_recovery_audit_created ON recovery_audit(created_at);

-- ===========================================
-- Exchange Rate Master (for REQ-1 Buy Point form)
-- ===========================================

CREATE TABLE IF NOT EXISTS exchange_rate_master (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency   VARCHAR(10) NOT NULL DEFAULT 'THB',
  target_currency VARCHAR(10) NOT NULL,  -- 'LAK' | 'USD' | 'BUPOINT'
  rate            DECIMAL(18,6) NOT NULL,
  effective_at    TIMESTAMP NOT NULL,
  expires_at      TIMESTAMP,
  source          VARCHAR(50),  -- 'BOT_API' | 'MANUAL' | 'CENTRAL_BANK'
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(base_currency, target_currency, effective_at)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rate_lookup 
  ON exchange_rate_master(base_currency, target_currency, effective_at DESC);

-- Insert sample data (replace with real data)
INSERT INTO exchange_rate_master (base_currency, target_currency, rate, effective_at, source)
VALUES
  ('THB', 'LAK', 625.00, NOW(), 'BOT_API'),
  ('THB', 'USD', 0.0286, NOW(), 'BOT_API'),
  ('THB', 'BUPOINT', 10.00, NOW(), 'MANUAL')
ON CONFLICT DO NOTHING;

-- ===========================================
-- Comments
-- ===========================================

COMMENT ON TABLE bct_hold_queue IS 'Phase A QW-3: Hold BCT ที่เสี่ยงก่อน permanent fix';
COMMENT ON TABLE wallet_status_log IS 'Phase A QW-1: Track every wallet state change';
COMMENT ON TABLE recovery_audit IS 'Phase A QW-2: Audit log สำหรับ MSP recovery (PDPA)';
COMMENT ON TABLE exchange_rate_master IS 'REQ-1: Exchange rates for Buy Point form';

-- ===========================================
-- Rollback (if needed)
-- ===========================================

-- To rollback, run:
-- DROP TABLE IF EXISTS bct_hold_queue;
-- DROP TABLE IF EXISTS wallet_status_log;
-- DROP TABLE IF EXISTS recovery_audit;
-- DROP TABLE IF EXISTS exchange_rate_master;
-- ALTER TABLE msp_transaction
--   DROP COLUMN IF EXISTS person_id_snapshot,
--   DROP COLUMN IF EXISTS risk_level,
--   DROP COLUMN IF EXISTS requires_approval,
--   DROP COLUMN IF EXISTS approved_by,
--   DROP COLUMN IF EXISTS approved_at,
--   DROP COLUMN IF EXISTS wallet_status_at_txn;
