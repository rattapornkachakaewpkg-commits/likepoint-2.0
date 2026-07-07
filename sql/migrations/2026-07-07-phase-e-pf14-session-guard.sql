-- ============================================================
-- Session Guard & Idempotency — PF-14 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Middleware layer for all API endpoints — auth, session, idempotency, feature gate
-- Applies PF-13 bug-fixes in production: TokenValidator, IdempotencyLock, validateAmount, redactSensitive
-- ============================================================

BEGIN;

-- ============================================================
-- 1. request_idempotency — persistent idempotency key store
-- ============================================================
CREATE TABLE IF NOT EXISTS request_idempotency (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,                         -- request idempotency key
  endpoint TEXT NOT NULL,                          -- /api/wallet/credit, /api/gift-card/redeem, etc.
  method TEXT NOT NULL,                            -- GET, POST, PUT, DELETE
  member_id UUID,                                  -- request initiator
  request_hash TEXT,                               -- hash of body to detect different requests with same key
  result JSONB,                                    -- cached response
  status_code INT,                                 -- HTTP status
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL                  -- created_at + ttl (default 5min)
);

CREATE INDEX IF NOT EXISTS idx_idem_expires ON request_idempotency (expires_at);
CREATE INDEX IF NOT EXISTS idx_idem_member ON request_idempotency (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idem_endpoint ON request_idempotency (endpoint, created_at DESC);

-- ============================================================
-- 2. sessions — active user sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,                 -- SES-{ts}-{seq}
  member_id UUID NOT NULL,
  ip_address INET,
  device_id TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,                 -- created_at + max_age
  destroyed_at TIMESTAMPTZ,
  destroy_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_member ON sessions (member_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_expires ON sessions (expires_at) WHERE destroyed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_active ON sessions (member_id) WHERE destroyed_at IS NULL;

-- ============================================================
-- 3. View: v_active_sessions
-- ============================================================
CREATE OR REPLACE VIEW v_active_sessions AS
SELECT
  s.session_id,
  s.member_id,
  s.ip_address,
  s.device_id,
  s.last_seen_at,
  s.expires_at,
  EXTRACT(EPOCH FROM (s.expires_at - now())) / 60 AS minutes_until_expiry
FROM sessions s
WHERE s.destroyed_at IS NULL AND s.expires_at > now();

-- ============================================================
-- 4. Function: get_session_stats()
-- ============================================================
CREATE OR REPLACE FUNCTION get_session_stats()
RETURNS TABLE (
  active_sessions BIGINT,
  expired_sessions BIGINT,
  total_sessions BIGINT,
  unique_members BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM sessions WHERE destroyed_at IS NULL AND expires_at > now()),
    (SELECT COUNT(*) FROM sessions WHERE expires_at <= now() AND destroyed_at IS NULL),
    (SELECT COUNT(*) FROM sessions),
    (SELECT COUNT(DISTINCT member_id) FROM sessions);
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_active_sessions LIMIT 10;
-- SELECT * FROM get_session_stats();
-- ============================================================
