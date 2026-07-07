-- ============================================================
-- POI Marketing Engine — PF-7 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Point-of-Interest trigger rules + audience filter + cooldown + reward history
-- Enables engagement loop ("กดรับทุกเช้า" UBI habit per PVP)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. poi_rules — extended POI rule storage
-- ============================================================
CREATE TABLE IF NOT EXISTS poi_rules_v2 (
  id BIGSERIAL PRIMARY KEY,
  rule_id TEXT UNIQUE NOT NULL,                     -- POIR-{ts}-{seq}
  merchant_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,                         -- daily_login, purchase, referral, review, birthday, custom
  reward_amount NUMERIC(18,2) NOT NULL CHECK (reward_amount > 0),
  reward_type TEXT NOT NULL DEFAULT 'fixed',        -- fixed, multiplier, random
  cooldown INTERVAL,                                -- ISO-8601 (PT24H, P7D)
  cooldown_ms BIGINT,                               -- parsed ms for fast comparison
  audience_filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_triggers_per_user INT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',            -- active, paused
  triggered_count BIGINT NOT NULL DEFAULT 0,
  total_rewarded NUMERIC(24,2) NOT NULL DEFAULT 0,
  unique_users BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poir_merchant ON poi_rules_v2 (merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_poir_token ON poi_rules_v2 (token_id, event_type);
CREATE INDEX IF NOT EXISTS idx_poir_event ON poi_rules_v2 (event_type, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_poir_window ON poi_rules_v2 (start_at, end_at) WHERE status = 'active';

-- ============================================================
-- 2. poi_triggers — every POI reward trigger (audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS poi_triggers (
  id BIGSERIAL PRIMARY KEY,
  trigger_id TEXT UNIQUE NOT NULL,                  -- POIT-{ts}-{seq}
  rule_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  reward_amount NUMERIC(18,2) NOT NULL,
  credit_txn_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL,                             -- REWARDED, COOLDOWN, NOT_IN_AUDIENCE, MAX_TRIGGERS_REACHED, CREDIT_FAILED, EXPIRED, NOT_STARTED
  error TEXT,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_poit_member ON poi_triggers (member_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_poit_rule ON poi_triggers (rule_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_poit_merchant ON poi_triggers (merchant_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_poit_status ON poi_triggers (status, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_poit_idem ON poi_triggers (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 3. View: v_poi_rule_stats — per-rule analytics
-- ============================================================
CREATE OR REPLACE VIEW v_poi_rule_stats AS
SELECT
  r.rule_id,
  r.merchant_id,
  r.name AS rule_name,
  r.event_type,
  r.reward_amount,
  r.reward_type,
  r.cooldown,
  r.audience_filter,
  r.status,
  r.triggered_count,
  r.total_rewarded,
  r.unique_users,
  COUNT(t.trigger_id) FILTER (WHERE t.status = 'REWARDED' AND t.triggered_at >= now() - INTERVAL '7 days') AS triggers_7d,
  COUNT(DISTINCT t.member_id) FILTER (WHERE t.status = 'REWARDED' AND t.triggered_at >= now() - INTERVAL '7 days') AS unique_users_7d,
  COALESCE(SUM(t.reward_amount) FILTER (WHERE t.status = 'REWARDED' AND t.triggered_at >= now() - INTERVAL '7 days'), 0) AS rewarded_7d
FROM poi_rules_v2 r
LEFT JOIN poi_triggers t ON t.rule_id = r.rule_id
GROUP BY r.rule_id, r.merchant_id, r.name, r.event_type, r.reward_amount, r.reward_type, r.cooldown, r.audience_filter, r.status, r.triggered_count, r.total_rewarded, r.unique_users;

-- ============================================================
-- 4. View: v_poi_recent_activity — feed for monitoring
-- ============================================================
CREATE OR REPLACE VIEW v_poi_recent_activity AS
SELECT
  t.trigger_id,
  t.rule_id,
  t.merchant_id,
  t.token_id,
  t.member_id,
  t.event_type,
  t.reward_amount,
  t.status,
  t.triggered_at,
  r.name AS rule_name,
  r.cooldown
FROM poi_triggers t
LEFT JOIN poi_rules_v2 r ON r.rule_id = t.rule_id
ORDER BY t.triggered_at DESC
LIMIT 1000;

-- ============================================================
-- 5. View: v_poi_member_streaks — engagement metrics
-- ============================================================
CREATE OR REPLACE VIEW v_poi_member_streaks AS
SELECT
  member_id,
  merchant_id,
  COUNT(*) FILTER (WHERE status = 'REWARDED') AS total_rewards,
  COUNT(DISTINCT DATE(triggered_at)) FILTER (WHERE status = 'REWARDED') AS active_days,
  MAX(triggered_at) FILTER (WHERE status = 'REWARDED') AS last_reward_at,
  EXTRACT(DAY FROM (now() - MAX(triggered_at) FILTER (WHERE status = 'REWARDED'))) AS days_since_last
FROM poi_triggers
GROUP BY member_id, merchant_id;

-- ============================================================
-- 6. RLS — merchant sees own, admin sees all
-- ============================================================
ALTER TABLE poi_rules_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE poi_triggers ENABLE ROW LEVEL SECURITY;

-- rules
DROP POLICY IF EXISTS poir_own ON poi_rules_v2;
CREATE POLICY poir_own ON poi_rules_v2
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'merchant'
    AND merchant_id = current_setting('app.current_merchant_id', true)
  );

DROP POLICY IF EXISTS poir_admin_all ON poi_rules_v2;
CREATE POLICY poir_admin_all ON poi_rules_v2
  FOR ALL
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS poir_service_all ON poi_rules_v2;
CREATE POLICY poir_service_all ON poi_rules_v2
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- triggers (read-only for merchant, full for admin)
DROP POLICY IF EXISTS poit_own_read ON poi_triggers;
CREATE POLICY poit_own_read ON poi_triggers
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'merchant'
    AND merchant_id = current_setting('app.current_merchant_id', true)
  );

DROP POLICY IF EXISTS poit_admin_all ON poi_triggers;
CREATE POLICY poit_admin_all ON poi_triggers
  FOR ALL
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS poit_service_all ON poi_triggers;
CREATE POLICY poit_service_all ON poi_triggers
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 7. Function: get_poi_engagement(p_merchant_id, p_days)
-- ============================================================
CREATE OR REPLACE FUNCTION get_poi_engagement(p_merchant_id TEXT, p_days INT DEFAULT 7)
RETURNS TABLE (
  active_rules BIGINT,
  total_triggers BIGINT,
  unique_users BIGINT,
  total_rewarded NUMERIC,
  top_event_type TEXT,
  daily_average NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM poi_rules_v2 WHERE merchant_id = p_merchant_id AND status = 'active'),
    (SELECT COUNT(*) FROM poi_triggers WHERE merchant_id = p_merchant_id AND status = 'REWARDED' AND triggered_at >= now() - (p_days || ' days')::INTERVAL),
    (SELECT COUNT(DISTINCT member_id) FROM poi_triggers WHERE merchant_id = p_merchant_id AND status = 'REWARDED' AND triggered_at >= now() - (p_days || ' days')::INTERVAL),
    COALESCE((SELECT SUM(reward_amount) FROM poi_triggers WHERE merchant_id = p_merchant_id AND status = 'REWARDED' AND triggered_at >= now() - (p_days || ' days')::INTERVAL), 0),
    (SELECT event_type FROM poi_triggers WHERE merchant_id = p_merchant_id AND status = 'REWARDED' AND triggered_at >= now() - (p_days || ' days')::INTERVAL GROUP BY event_type ORDER BY COUNT(*) DESC LIMIT 1),
    COALESCE((SELECT COUNT(*)::NUMERIC / GREATEST(p_days, 1) FROM poi_triggers WHERE merchant_id = p_merchant_id AND status = 'REWARDED' AND triggered_at >= now() - (p_days || ' days')::INTERVAL), 0);
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_poi_rule_stats WHERE merchant_id = 'MCH-...' LIMIT 10;
-- SELECT * FROM v_poi_recent_activity LIMIT 20;
-- SELECT * FROM v_poi_member_streaks WHERE active_days >= 7 LIMIT 10;
-- SELECT * FROM get_poi_engagement('MCH-...', 7);
-- ============================================================
