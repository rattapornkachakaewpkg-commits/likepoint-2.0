-- ============================================================
-- White-Label Merchant Engine — PF-6 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Multi-tenant white-label merchant onboarding + token minting + POI rules
-- Based on PVP vision (28/09/2022): "Likepoint 2.0 is white-label SaaS"
-- ============================================================

BEGIN;

-- ============================================================
-- 1. merchants — business tenants (BUs / SMEs)
-- ============================================================
CREATE TABLE IF NOT EXISTS merchants (
  id BIGSERIAL PRIMARY KEY,
  merchant_id TEXT UNIQUE NOT NULL,                  -- MCH-{ts}-{seq}
  business_name TEXT NOT NULL,
  slug TEXT NOT NULL,                                -- URL-friendly
  contact_email TEXT NOT NULL,
  country TEXT NOT NULL,                             -- ISO-3166 alpha-2
  tier TEXT NOT NULL DEFAULT 'starter',              -- starter | pro | enterprise
  kyc_status TEXT NOT NULL DEFAULT 'not_required',   -- not_required | pending | approved | rejected
  kyc_documents JSONB,
  api_key_hash TEXT,                                 -- bcrypt/argon2 in prod
  config JSONB NOT NULL DEFAULT '{}'::jsonb,         -- branding, notifications
  status TEXT NOT NULL DEFAULT 'active',             -- active | suspended | churned
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(country, slug)                              -- unique business per country
);

CREATE INDEX IF NOT EXISTS idx_merchants_tier ON merchants (tier) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_merchants_country ON merchants (country);
CREATE INDEX IF NOT EXISTS idx_merchants_kyc ON merchants (kyc_status) WHERE kyc_status = 'pending';

-- ============================================================
-- 2. merchant_tokens — white-label tokens per merchant
-- ============================================================
CREATE TABLE IF NOT EXISTS merchant_tokens (
  id BIGSERIAL PRIMARY KEY,
  token_id TEXT UNIQUE NOT NULL,                     -- TOK-{ts}-{seq}
  merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,                              -- uppercase, 3-5 chars
  decimals INT NOT NULL DEFAULT 2 CHECK (decimals >= 0 AND decimals <= 18),
  peg_currency TEXT NOT NULL,                        -- ISO-4217 (THB, USD, KHR...)
  peg_rate NUMERIC(18,8) NOT NULL CHECK (peg_rate > 0),
  total_supply NUMERIC(24,2) NOT NULL DEFAULT 0,
  circulating_supply NUMERIC(24,2) NOT NULL DEFAULT 0,
  icon_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',             -- active | paused | deprecated
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(merchant_id, symbol)                        -- symbol unique per merchant
);

CREATE INDEX IF NOT EXISTS idx_tokens_merchant ON merchant_tokens (merchant_id);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON merchant_tokens (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tokens_peg ON merchant_tokens (peg_currency);

-- ============================================================
-- 3. poi_rules — point-of-interest reward rules
-- ============================================================
CREATE TABLE IF NOT EXISTS poi_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_id TEXT UNIQUE NOT NULL,                      -- RULE-{ts}-{idx}
  merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES merchant_tokens(token_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                          -- daily_login | purchase | referral | review | birthday | custom
  reward_amount NUMERIC(18,2) NOT NULL CHECK (reward_amount > 0),
  reward_type TEXT NOT NULL DEFAULT 'fixed',         -- fixed | multiplier | random
  cooldown INTERVAL,                                 -- ISO-8601 (PT24H, P7D)
  audience_filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',             -- active | paused
  triggered_count BIGINT NOT NULL DEFAULT 0,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poi_merchant ON poi_rules (merchant_id);
CREATE INDEX IF NOT EXISTS idx_poi_token ON poi_rules (token_id);
CREATE INDEX IF NOT EXISTS idx_poi_event ON poi_rules (event_type, status);
CREATE INDEX IF NOT EXISTS idx_poi_active ON poi_rules (status) WHERE status = 'active';

-- ============================================================
-- 4. token_mints — mint history (audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS token_mints (
  id BIGSERIAL PRIMARY KEY,
  mint_batch_id TEXT UNIQUE NOT NULL,                -- MINT-{ts}-{seq}
  merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
  token_id TEXT NOT NULL REFERENCES merchant_tokens(token_id),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  payment_ref TEXT,
  minted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_mints_merchant ON token_mints (merchant_id, minted_at DESC);
CREATE INDEX IF NOT EXISTS idx_mints_token ON token_mints (token_id, minted_at DESC);

-- ============================================================
-- 5. View: v_merchant_summary — admin dashboard
-- ============================================================
CREATE OR REPLACE VIEW v_merchant_summary AS
SELECT
  m.merchant_id,
  m.business_name,
  m.country,
  m.tier,
  m.kyc_status,
  m.status,
  m.created_at,
  COUNT(DISTINCT t.token_id) AS token_count,
  COALESCE(SUM(t.total_supply), 0) AS total_supply,
  COALESCE(SUM(t.circulating_supply), 0) AS circulating_supply,
  COUNT(DISTINCT p.rule_id) AS poi_rule_count
FROM merchants m
LEFT JOIN merchant_tokens t ON t.merchant_id = m.merchant_id
LEFT JOIN poi_rules p ON p.merchant_id = m.merchant_id
GROUP BY m.merchant_id, m.business_name, m.country, m.tier, m.kyc_status, m.status, m.created_at;

-- ============================================================
-- 6. View: v_poi_recent — recent POI activity
-- ============================================================
CREATE OR REPLACE VIEW v_poi_recent AS
SELECT
  p.rule_id,
  p.merchant_id,
  m.business_name,
  p.token_id,
  t.symbol AS token_symbol,
  p.event_type,
  p.reward_amount,
  p.reward_type,
  p.cooldown,
  p.triggered_count,
  p.last_triggered_at,
  p.status
FROM poi_rules p
JOIN merchants m ON m.merchant_id = p.merchant_id
JOIN merchant_tokens t ON t.token_id = p.token_id
ORDER BY p.last_triggered_at DESC NULLS LAST
LIMIT 1000;

-- ============================================================
-- 7. RLS — 3 roles: merchant (own data), admin (all), service (full)
-- ============================================================
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE poi_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_mints ENABLE ROW LEVEL SECURITY;

-- merchants
DROP POLICY IF EXISTS merchant_own ON merchants;
CREATE POLICY merchant_own ON merchants
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'merchant'
    AND merchant_id = current_setting('app.current_merchant_id', true)
  );

DROP POLICY IF EXISTS merchant_admin_all ON merchants;
CREATE POLICY merchant_admin_all ON merchants
  FOR ALL
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS merchant_service_all ON merchants;
CREATE POLICY merchant_service_all ON merchants
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- merchant_tokens
DROP POLICY IF EXISTS token_own ON merchant_tokens;
CREATE POLICY token_own ON merchant_tokens
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'merchant'
    AND merchant_id = current_setting('app.current_merchant_id', true)
  );

DROP POLICY IF EXISTS token_admin_all ON merchant_tokens;
CREATE POLICY token_admin_all ON merchant_tokens
  FOR ALL
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS token_service_all ON merchant_tokens;
CREATE POLICY token_service_all ON merchant_tokens
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- poi_rules (same isolation)
DROP POLICY IF EXISTS poi_own ON poi_rules;
CREATE POLICY poi_own ON poi_rules
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'merchant'
    AND merchant_id = current_setting('app.current_merchant_id', true)
  );

DROP POLICY IF EXISTS poi_admin_all ON poi_rules;
CREATE POLICY poi_admin_all ON poi_rules
  FOR ALL
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS poi_service_all ON poi_rules;
CREATE POLICY poi_service_all ON poi_rules
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- token_mints
DROP POLICY IF EXISTS mint_own ON token_mints;
CREATE POLICY mint_own ON token_mints
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'merchant'
    AND merchant_id = current_setting('app.current_merchant_id', true)
  );

DROP POLICY IF EXISTS mint_admin_all ON token_mints;
CREATE POLICY mint_admin_all ON token_mints
  FOR ALL
  USING (current_setting('app.current_role', true) IN ('admin', 'auditor'));

DROP POLICY IF EXISTS mint_service_all ON token_mints;
CREATE POLICY mint_service_all ON token_mints
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 8. Function: get_merchant_stats(p_merchant_id)
-- ============================================================
CREATE OR REPLACE FUNCTION get_merchant_stats(p_merchant_id TEXT)
RETURNS TABLE (
  merchant_id TEXT,
  business_name TEXT,
  tier TEXT,
  token_count BIGINT,
  total_supply NUMERIC,
  circulating_supply NUMERIC,
  poi_rule_count BIGINT,
  mint_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.merchant_id,
    m.business_name,
    m.tier,
    (SELECT COUNT(*) FROM merchant_tokens WHERE merchant_id = p_merchant_id),
    COALESCE((SELECT SUM(total_supply) FROM merchant_tokens WHERE merchant_id = p_merchant_id), 0),
    COALESCE((SELECT SUM(circulating_supply) FROM merchant_tokens WHERE merchant_id = p_merchant_id), 0),
    (SELECT COUNT(*) FROM poi_rules WHERE merchant_id = p_merchant_id),
    (SELECT COUNT(*) FROM token_mints WHERE merchant_id = p_merchant_id);
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_merchant_summary WHERE tier = 'starter' LIMIT 10;
-- SELECT * FROM v_poi_recent LIMIT 10;
-- SELECT * FROM get_merchant_stats('MCH-...');
-- ============================================================
