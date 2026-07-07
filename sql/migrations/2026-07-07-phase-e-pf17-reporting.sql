-- ============================================================
-- Reporting & Analytics Engine — PF-17 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Analytics dashboard data — MRR, retention, funnel, top merchants, KYC pipeline
-- Powers admin dashboard + B2B merchant analytics
-- ============================================================

BEGIN;

-- ============================================================
-- 1. report_cache — pre-computed analytics (refresh every 5 min)
-- ============================================================
CREATE TABLE IF NOT EXISTS report_cache (
  id BIGSERIAL PRIMARY KEY,
  report_key TEXT UNIQUE NOT NULL,                  -- 'mrr_daily', 'retention_7d', 'funnel_overview'
  report_name TEXT NOT NULL,
  data JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL                   -- computed_at + 5 min
);

CREATE INDEX IF NOT EXISTS idx_cache_key ON report_cache (report_key);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON report_cache (expires_at);

-- ============================================================
-- 2. View: v_daily_mrr — MRR trend (last 30 days)
-- ============================================================
CREATE OR REPLACE VIEW v_daily_mrr AS
SELECT
  DATE(s.started_at) AS day,
  COUNT(*) FILTER (WHERE s.status IN ('active', 'trial')) AS active_subs,
  SUM(s.price_thb) FILTER (WHERE s.status IN ('active', 'trial') AND s.billing_period = 'monthly') AS monthly_mrr,
  SUM(s.price_thb / 12) FILTER (WHERE s.status IN ('active', 'trial') AND s.billing_period = 'yearly') AS yearly_mrr_normalized
FROM member_subscriptions s
WHERE s.started_at >= now() - INTERVAL '30 days'
GROUP BY DATE(s.started_at)
ORDER BY day DESC;

-- ============================================================
-- 3. View: v_funnel_overview — current tier distribution
-- ============================================================
CREATE OR REPLACE VIEW v_funnel_overview AS
SELECT
  COUNT(*) FILTER (WHERE tier = 'free' OR tier IS NULL) AS free_count,
  COUNT(*) FILTER (WHERE tier = 'basic' OR tier = 'gold' OR tier = 'silver') AS basic_count,
  COUNT(*) FILTER (WHERE tier = 'pro') AS pro_count,
  COUNT(*) FILTER (WHERE tier = 'enterprise') AS enterprise_count,
  COUNT(*) AS total_members,
  ROUND(COUNT(*) FILTER (WHERE tier NOT IN ('free') AND tier IS NOT NULL)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS paid_conversion_pct
FROM members;

-- ============================================================
-- 4. View: v_top_merchants_30d
-- ============================================================
CREATE OR REPLACE VIEW v_top_merchants_30d AS
SELECT
  m.merchant_id,
  m.name,
  m.tier,
  m.country,
  COUNT(DISTINCT s.subscription_id) AS subscriber_count,
  COALESCE(SUM(b.amount) FILTER (WHERE b.status = 'succeeded' AND b.created_at >= now() - INTERVAL '30 days'), 0) AS revenue_30d
FROM merchants m
LEFT JOIN member_subscriptions s ON s.plan_id IN ('basic', 'pro') AND s.status IN ('active', 'trial')
LEFT JOIN subscription_billing b ON b.subscription_id = s.subscription_id
WHERE m.status = 'active'
GROUP BY m.merchant_id, m.name, m.tier, m.country
ORDER BY revenue_30d DESC
LIMIT 20;

-- ============================================================
-- 5. Function: refresh_report_cache(p_key)
-- ============================================================
CREATE OR REPLACE FUNCTION refresh_report_cache(p_key TEXT)
RETURNS void AS $$
BEGIN
  DELETE FROM report_cache WHERE report_key = p_key AND expires_at < now();
  -- Actual refresh logic would call ReportingEngine methods
  -- For prototype: just bump expires_at
  INSERT INTO report_cache (report_key, report_name, data, expires_at)
  VALUES (p_key, p_key, '{"status": "computed"}'::jsonb, now() + INTERVAL '5 minutes')
  ON CONFLICT (report_key) DO UPDATE SET computed_at = now(), expires_at = now() + INTERVAL '5 minutes';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. RLS
-- ============================================================
ALTER TABLE report_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cache_admin_read ON report_cache;
CREATE POLICY cache_admin_read ON report_cache
  FOR SELECT USING (current_setting('app.current_role', true) IN ('admin', 'auditor'));

DROP POLICY IF EXISTS cache_service_write ON report_cache;
CREATE POLICY cache_service_write ON report_cache
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_daily_mrr LIMIT 10;
-- SELECT * FROM v_funnel_overview;
-- SELECT * FROM v_top_merchants_30d;
-- SELECT refresh_report_cache('mrr_daily');
-- ============================================================
