-- ============================================================
-- FX Engine — PF-8 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Multi-currency FX rates + country-currency mapping + audit trail
-- Enables cross-border white-label tokens (Likepoint 1.0 FX risk fix)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. country_currency — country ↔ currency mapping
-- ============================================================
CREATE TABLE IF NOT EXISTS country_currency (
  id BIGSERIAL PRIMARY KEY,
  country_code TEXT UNIQUE NOT NULL,                -- ISO-3166 alpha-2 (TH, KH, LA...)
  currency_code TEXT NOT NULL,                      -- ISO-4217 (THB, KHR, LAK...)
  currency_name TEXT NOT NULL,
  decimals INT NOT NULL DEFAULT 2 CHECK (decimals >= 0 AND decimals <= 8),
  symbol TEXT,                                      -- ฿, $, ៛, ₭
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cc_currency ON country_currency (currency_code);
CREATE INDEX IF NOT EXISTS idx_cc_status ON country_currency (status) WHERE status = 'active';

-- ============================================================
-- 2. fx_rates — currency pair rates
-- ============================================================
CREATE TABLE IF NOT EXISTS fx_rates (
  id BIGSERIAL PRIMARY KEY,
  rate_id TEXT UNIQUE NOT NULL,                      -- FXR-{ts}-{seq}
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  source TEXT NOT NULL DEFAULT 'manual',             -- manual | provider | computed
  provider_name TEXT,                                -- e.g., 'xe.com', 'ecb'
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  actor TEXT NOT NULL DEFAULT 'admin',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fx_pair ON fx_rates (from_currency, to_currency, effective_at DESC);
CREATE INDEX IF NOT EXISTS idx_fx_effective ON fx_rates (effective_at DESC);
CREATE INDEX IF NOT EXISTS idx_fx_source ON fx_rates (source);
CREATE INDEX IF NOT EXISTS idx_fx_expires ON fx_rates (expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================
-- 3. fx_rate_history — point-in-time rate snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS fx_rate_history (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate NUMERIC(18,8) NOT NULL,
  source TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fxhist_date ON fx_rate_history (snapshot_date, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_fxhist_pair ON fx_rate_history (from_currency, to_currency, snapshot_date DESC);

-- ============================================================
-- 4. View: v_fx_latest_rates — current rates for all pairs
-- ============================================================
CREATE OR REPLACE VIEW v_fx_latest_rates AS
SELECT DISTINCT ON (from_currency, to_currency)
  from_currency,
  to_currency,
  rate,
  source,
  effective_at,
  expires_at,
  CASE WHEN expires_at IS NULL OR expires_at > now() THEN true ELSE false END AS is_valid
FROM fx_rates
ORDER BY from_currency, to_currency, effective_at DESC;

-- ============================================================
-- 5. View: v_country_currency_summary
-- ============================================================
CREATE OR REPLACE VIEW v_country_currency_summary AS
SELECT
  cc.country_code,
  cc.currency_code,
  cc.currency_name,
  cc.symbol,
  cc.decimals,
  COUNT(DISTINCT m.merchant_id) AS merchant_count,
  COUNT(DISTINCT t.token_id) AS token_count
FROM country_currency cc
LEFT JOIN merchants m ON m.country = cc.country_code AND m.status = 'active'
LEFT JOIN merchant_tokens t ON t.merchant_id = m.merchant_id
GROUP BY cc.country_code, cc.currency_code, cc.currency_name, cc.symbol, cc.decimals;

-- ============================================================
-- 6. RLS — admin (read+write), service (full)
-- ============================================================
ALTER TABLE country_currency ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rate_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cc_admin_all ON country_currency;
CREATE POLICY cc_admin_all ON country_currency
  FOR ALL
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS cc_service_all ON country_currency;
CREATE POLICY cc_service_all ON country_currency
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

DROP POLICY IF EXISTS fx_admin_read ON fx_rates;
CREATE POLICY fx_admin_read ON fx_rates
  FOR SELECT
  USING (current_setting('app.current_role', true) IN ('admin', 'auditor'));

DROP POLICY IF EXISTS fx_admin_write ON fx_rates;
CREATE POLICY fx_admin_write ON fx_rates
  FOR ALL
  USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS fx_service_all ON fx_rates;
CREATE POLICY fx_service_all ON fx_rates
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

DROP POLICY IF EXISTS fxhist_admin_read ON fx_rate_history;
CREATE POLICY fxhist_admin_read ON fx_rate_history
  FOR SELECT
  USING (current_setting('app.current_role', true) IN ('admin', 'auditor'));

DROP POLICY IF EXISTS fxhist_service_all ON fx_rate_history;
CREATE POLICY fxhist_service_all ON fx_rate_history
  FOR ALL
  USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 7. Function: get_fx_rate(from, to)
-- ============================================================
CREATE OR REPLACE FUNCTION get_fx_rate(p_from TEXT, p_to TEXT)
RETURNS NUMERIC AS $$
DECLARE
  v_rate NUMERIC;
BEGIN
  IF p_from = p_to THEN RETURN 1.0; END IF;

  -- Direct
  SELECT rate INTO v_rate FROM v_fx_latest_rates
  WHERE from_currency = p_from AND to_currency = p_to AND is_valid = true LIMIT 1;
  IF v_rate IS NOT NULL THEN RETURN v_rate; END IF;

  -- Inverse
  SELECT 1.0 / rate INTO v_rate FROM v_fx_latest_rates
  WHERE from_currency = p_to AND to_currency = p_from AND is_valid = true LIMIT 1;
  IF v_rate IS NOT NULL THEN RETURN v_rate; END IF;

  -- Triangulate via USD
  SELECT r1.rate * r2.rate INTO v_rate
  FROM v_fx_latest_rates r1, v_fx_latest_rates r2
  WHERE r1.from_currency = p_from AND r1.to_currency = 'USD' AND r1.is_valid = true
    AND r2.from_currency = 'USD' AND r2.to_currency = p_to AND r2.is_valid = true
  LIMIT 1;

  RETURN COALESCE(v_rate, NULL);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 8. Seed: ASEAN countries + common currencies
-- ============================================================
INSERT INTO country_currency (country_code, currency_code, currency_name, decimals, symbol) VALUES
  ('TH', 'THB', 'Thai Baht', 2, '฿'),
  ('KH', 'KHR', 'Cambodian Riel', 2, '៛'),
  ('LA', 'LAK', 'Lao Kip', 2, '₭'),
  ('MM', 'MMK', 'Myanmar Kyat', 2, 'K'),
  ('VN', 'VND', 'Vietnamese Dong', 0, '₫'),
  ('MY', 'MYR', 'Malaysian Ringgit', 2, 'RM'),
  ('SG', 'SGD', 'Singapore Dollar', 2, 'S$'),
  ('PH', 'PHP', 'Philippine Peso', 2, '₱'),
  ('ID', 'IDR', 'Indonesian Rupiah', 2, 'Rp'),
  ('US', 'USD', 'US Dollar', 2, '$'),
  ('AE', 'AED', 'UAE Dirham', 2, 'د.إ')
ON CONFLICT (country_code) DO NOTHING;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_fx_latest_rates ORDER BY from_currency, to_currency;
-- SELECT * FROM v_country_currency_summary;
-- SELECT get_fx_rate('USD', 'THB');
-- SELECT get_fx_rate('THB', 'KHR');
-- SELECT get_fx_rate('USD', 'KHR');
-- ============================================================
