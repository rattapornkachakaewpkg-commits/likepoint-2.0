-- ============================================================
-- Subscription Engine — PF-9 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Recurring revenue via 3-tier plans (Free / Basic 10 THB / Pro 99 THB)
-- Based on NB vision (25/06/2023): subscription ฿10/mo for earn point + Lotto
-- ============================================================

BEGIN;

-- ============================================================
-- 1. subscription_plans
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id BIGSERIAL PRIMARY KEY,
  plan_id TEXT UNIQUE NOT NULL,                      -- free | basic | pro
  name TEXT NOT NULL,
  price_thb NUMERIC(10,2) NOT NULL CHECK (price_thb >= 0),
  billing_period TEXT NOT NULL DEFAULT 'monthly',    -- monthly | yearly
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  badge TEXT,
  trial_days INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plans_status ON subscription_plans (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_plans_price ON subscription_plans (price_thb);

-- ============================================================
-- 2. member_subscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS member_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  subscription_id TEXT UNIQUE NOT NULL,               -- SUB-{ts}-{seq}
  member_id UUID NOT NULL,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(plan_id),
  status TEXT NOT NULL DEFAULT 'active',             -- trial | active | past_due | cancelled | expired
  idempotency_key TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  next_billing_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  grace_period_ends_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  auto_renew BOOLEAN NOT NULL DEFAULT true,
  payment_method TEXT NOT NULL DEFAULT 'promptpay',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_idem ON member_subscriptions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sub_member ON member_subscriptions (member_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_plan ON member_subscriptions (plan_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_status ON member_subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_sub_billing ON member_subscriptions (next_billing_at) WHERE status IN ('active', 'past_due');
CREATE INDEX IF NOT EXISTS idx_sub_grace ON member_subscriptions (grace_period_ends_at) WHERE status = 'past_due';

-- ============================================================
-- 3. subscription_billing — payment history
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_billing (
  id BIGSERIAL PRIMARY KEY,
  billing_id TEXT UNIQUE NOT NULL,                   -- BIL-{ts}-{seq}
  subscription_id TEXT NOT NULL REFERENCES member_subscriptions(subscription_id),
  member_id UUID NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  payment_method TEXT NOT NULL,
  payment_ref TEXT,
  status TEXT NOT NULL,                              -- pending | succeeded | failed | refunded
  billing_period_start TIMESTAMPTZ NOT NULL,
  billing_period_end TIMESTAMPTZ NOT NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bill_sub ON subscription_billing (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bill_status ON subscription_billing (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bill_member ON subscription_billing (member_id, created_at DESC);

-- ============================================================
-- 4. View: v_subscription_revenue — MRR by plan
-- ============================================================
CREATE OR REPLACE VIEW v_subscription_revenue AS
SELECT
  p.plan_id,
  p.name AS plan_name,
  p.price_thb,
  p.billing_period,
  COUNT(s.subscription_id) FILTER (WHERE s.status IN ('active', 'trial')) AS active_subs,
  COALESCE(SUM(b.amount) FILTER (WHERE b.status = 'succeeded' AND b.created_at >= now() - INTERVAL '30 days'), 0) AS revenue_30d,
  COALESCE(SUM(b.amount) FILTER (WHERE b.status = 'succeeded' AND b.created_at >= now() - INTERVAL '7 days'), 0) AS revenue_7d,
  COALESCE(SUM(CASE WHEN p.billing_period = 'monthly' THEN p.price_thb ELSE p.price_thb / 12 END) FILTER (WHERE s.status IN ('active', 'trial')), 0) AS mrr_contribution
FROM subscription_plans p
LEFT JOIN member_subscriptions s ON s.plan_id = p.plan_id
LEFT JOIN subscription_billing b ON b.subscription_id = s.subscription_id
GROUP BY p.plan_id, p.name, p.price_thb, p.billing_period;

-- ============================================================
-- 5. View: v_subscription_dashboard
-- ============================================================
CREATE OR REPLACE VIEW v_subscription_dashboard AS
SELECT
  COUNT(*) FILTER (WHERE status = 'active') AS active_count,
  COUNT(*) FILTER (WHERE status = 'trial') AS trial_count,
  COUNT(*) FILTER (WHERE status = 'past_due') AS past_due_count,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
  COUNT(*) AS total_count,
  COUNT(*) FILTER (WHERE next_billing_at >= now() AND next_billing_at < now() + INTERVAL '7 days' AND status = 'active') AS due_for_renewal_7d,
  COUNT(*) FILTER (WHERE grace_period_ends_at >= now() AND status = 'past_due') AS in_grace_period
FROM member_subscriptions;

-- ============================================================
-- 6. RLS — member (own), admin (all), service (full)
-- ============================================================
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_billing ENABLE ROW LEVEL SECURITY;

-- plans (public read, admin write)
DROP POLICY IF EXISTS plan_public_read ON subscription_plans;
CREATE POLICY plan_public_read ON subscription_plans
  FOR SELECT USING (status = 'active');

DROP POLICY IF EXISTS plan_admin_all ON subscription_plans;
CREATE POLICY plan_admin_all ON subscription_plans
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS plan_service_all ON subscription_plans;
CREATE POLICY plan_service_all ON subscription_plans
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- member_subscriptions
DROP POLICY IF EXISTS sub_own ON member_subscriptions;
CREATE POLICY sub_own ON member_subscriptions
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'member'
    AND member_id::text = current_setting('app.current_member_id', true)
  );

DROP POLICY IF EXISTS sub_admin_all ON member_subscriptions;
CREATE POLICY sub_admin_all ON member_subscriptions
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS sub_service_all ON member_subscriptions;
CREATE POLICY sub_service_all ON member_subscriptions
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- billing
DROP POLICY IF EXISTS bill_own ON subscription_billing;
CREATE POLICY bill_own ON subscription_billing
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'member'
    AND member_id::text = current_setting('app.current_member_id', true)
  );

DROP POLICY IF EXISTS bill_admin_all ON subscription_billing;
CREATE POLICY bill_admin_all ON subscription_billing
  FOR ALL USING (current_setting('app.current_role', true) IN ('admin', 'auditor'));

DROP POLICY IF EXISTS bill_service_all ON subscription_billing;
CREATE POLICY bill_service_all ON subscription_billing
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 7. Function: get_member_subscription(member_id)
-- ============================================================
CREATE OR REPLACE FUNCTION get_member_subscription(p_member_id UUID)
RETURNS TABLE (
  subscription_id TEXT,
  plan_id TEXT,
  plan_name TEXT,
  status TEXT,
  is_trial BOOLEAN,
  days_remaining INT,
  current_period_end TIMESTAMPTZ,
  next_billing_at TIMESTAMPTZ,
  auto_renew BOOLEAN,
  features JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.subscription_id,
    s.plan_id,
    p.name,
    s.status,
    s.status = 'trial' AS is_trial,
    GREATEST(0, EXTRACT(DAY FROM (s.current_period_end - now()))::INT) AS days_remaining,
    s.current_period_end,
    s.next_billing_at,
    s.auto_renew,
    p.features
  FROM member_subscriptions s
  JOIN subscription_plans p ON p.plan_id = s.plan_id
  WHERE s.member_id = p_member_id
    AND s.status IN ('trial', 'active', 'past_due')
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 8. Seed: 3 default plans
-- ============================================================
INSERT INTO subscription_plans (plan_id, name, price_thb, billing_period, features, badge, trial_days) VALUES
  ('free', 'Free', 0, 'monthly', '["basic_poi", "daily_claim"]'::jsonb, NULL, 0),
  ('basic', 'Basic', 10, 'monthly', '["lotto_weekly", "poi_2x", "ad_free"]'::jsonb, 'แนะนำ', 7),
  ('pro', 'Pro', 99, 'monthly', '["lotto_daily", "poi_5x", "ad_free", "premium_poi", "priority_support"]'::jsonb, '⭐', 7)
ON CONFLICT (plan_id) DO UPDATE SET
  name = EXCLUDED.name,
  price_thb = EXCLUDED.price_thb,
  features = EXCLUDED.features,
  trial_days = EXCLUDED.trial_days,
  updated_at = now();

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM subscription_plans ORDER BY price_thb;
-- SELECT * FROM v_subscription_revenue;
-- SELECT * FROM v_subscription_dashboard;
-- SELECT * FROM get_member_subscription('uuid...');
-- ============================================================
