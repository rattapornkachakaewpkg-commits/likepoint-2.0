-- ============================================================
-- Voucher Engine — PF-12 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Coupons with expiry + discount — merchant promo tool
-- Based on Likepoint meeting 16/12/2022: "Gift Voucher (มีระยะเวลา จำนวน Point ที่กำหนด)"
-- ============================================================

BEGIN;

-- ============================================================
-- 1. vouchers
-- ============================================================
CREATE TABLE IF NOT EXISTS vouchers (
  id BIGSERIAL PRIMARY KEY,
  voucher_id TEXT UNIQUE NOT NULL,                   -- VCH-{ts}-{seq}
  code TEXT UNIQUE NOT NULL,                         -- 10-char or custom
  merchant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  discount_type TEXT NOT NULL,                       -- percentage | fixed
  discount_value NUMERIC(18,2) NOT NULL CHECK (discount_value > 0),
  min_purchase NUMERIC(18,2) NOT NULL DEFAULT 0,
  max_discount NUMERIC(18,2),
  total_quantity INT NOT NULL DEFAULT 1 CHECK (total_quantity > 0),
  per_user_limit INT NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
  redeemed_count INT NOT NULL DEFAULT 0,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  applicable_token_id TEXT,
  applicable_products JSONB,
  status TEXT NOT NULL DEFAULT 'active',             -- active | paused | expired | exhausted
  void_reason TEXT,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until > valid_from),
  CHECK (discount_type != 'percentage' OR (discount_value > 0 AND discount_value <= 100))
);

CREATE INDEX IF NOT EXISTS idx_voucher_merchant ON vouchers (merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_voucher_status ON vouchers (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_voucher_valid ON vouchers (valid_until) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_voucher_exhausted ON vouchers (redeemed_count, total_quantity) WHERE status = 'active';

-- ============================================================
-- 2. voucher_redemptions
-- ============================================================
CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id BIGSERIAL PRIMARY KEY,
  redemption_id TEXT UNIQUE NOT NULL,                -- VRED-{ts}-{seq}
  voucher_id TEXT NOT NULL REFERENCES vouchers(voucher_id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  member_id UUID NOT NULL,
  purchase_amount NUMERIC(18,2) NOT NULL,
  discount_amount NUMERIC(18,2) NOT NULL,
  final_amount NUMERIC(18,2) NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_vred_voucher ON voucher_redemptions (voucher_id, redeemed_at DESC);
CREATE INDEX IF NOT EXISTS idx_vred_member ON voucher_redemptions (member_id, redeemed_at DESC);
CREATE INDEX IF NOT EXISTS idx_vred_time ON voucher_redemptions (redeemed_at DESC);

-- ============================================================
-- 3. View: v_voucher_active
-- ============================================================
CREATE OR REPLACE VIEW v_voucher_active AS
SELECT
  v.voucher_id,
  v.code,
  v.merchant_id,
  v.name,
  v.discount_type,
  v.discount_value,
  v.min_purchase,
  v.total_quantity,
  v.redeemed_count,
  v.total_quantity - v.redeemed_count AS remaining,
  v.per_user_limit,
  v.valid_from,
  v.valid_until,
  EXTRACT(EPOCH FROM (v.valid_until - now())) / 3600 AS hours_until_expiry,
  CASE
    WHEN v.redeemed_count >= v.total_quantity THEN 'sold_out'
    WHEN now() > v.valid_until THEN 'expired'
    WHEN now() < v.valid_from THEN 'not_started'
    ELSE 'active'
  END AS display_status
FROM vouchers v
WHERE v.status = 'active';

-- ============================================================
-- 4. View: v_voucher_stats
-- ============================================================
CREATE OR REPLACE VIEW v_voucher_stats AS
SELECT
  v.merchant_id,
  COUNT(v.voucher_id) AS total_vouchers,
  COUNT(v.voucher_id) FILTER (WHERE v.status = 'active') AS active_vouchers,
  COUNT(v.voucher_id) FILTER (WHERE v.status = 'exhausted') AS exhausted_vouchers,
  COUNT(v.voucher_id) FILTER (WHERE v.status = 'expired') AS expired_vouchers,
  COALESCE(SUM(r.discount_amount), 0) AS total_discount_given,
  COALESCE(SUM(r.purchase_amount), 0) AS total_sales_generated,
  COUNT(r.redemption_id) AS total_redemptions
FROM vouchers v
LEFT JOIN voucher_redemptions r ON r.voucher_id = v.voucher_id
GROUP BY v.merchant_id;

-- ============================================================
-- 5. RLS
-- ============================================================
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_redemptions ENABLE ROW LEVEL SECURITY;

-- vouchers: public can see active, admin all
DROP POLICY IF EXISTS vch_public_read ON vouchers;
CREATE POLICY vch_public_read ON vouchers
  FOR SELECT USING (status = 'active' AND now() BETWEEN valid_from AND valid_until);

DROP POLICY IF EXISTS vch_merchant_own ON vouchers;
CREATE POLICY vch_merchant_own ON vouchers
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'merchant'
    AND merchant_id = current_setting('app.current_merchant_id', true)
  );

DROP POLICY IF EXISTS vch_admin_all ON vouchers;
CREATE POLICY vch_admin_all ON vouchers
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS vch_service_all ON vouchers;
CREATE POLICY vch_service_all ON vouchers
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- redemptions: member own, merchant own (vouchers of), admin all
DROP POLICY IF EXISTS vred_own ON voucher_redemptions;
CREATE POLICY vred_own ON voucher_redemptions
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'member'
    AND member_id::text = current_setting('app.current_member_id', true)
  );

DROP POLICY IF EXISTS vred_merchant ON voucher_redemptions;
CREATE POLICY vred_merchant ON voucher_redemptions
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'merchant'
    AND voucher_id IN (SELECT voucher_id FROM vouchers WHERE merchant_id = current_setting('app.current_merchant_id', true))
  );

DROP POLICY IF EXISTS vred_admin_all ON voucher_redemptions;
CREATE POLICY vred_admin_all ON voucher_redemptions
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS vred_service_all ON voucher_redemptions;
CREATE POLICY vred_service_all ON voucher_redemptions
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 6. Function: get_voucher_stats(p_merchant_id, p_since)
-- ============================================================
CREATE OR REPLACE FUNCTION get_voucher_stats(p_merchant_id TEXT, p_since TIMESTAMPTZ DEFAULT now() - INTERVAL '7 days')
RETURNS TABLE (
  total_vouchers BIGINT,
  active_vouchers BIGINT,
  total_redemptions BIGINT,
  total_sales NUMERIC,
  total_discount NUMERIC,
  unique_customers BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM vouchers WHERE merchant_id = p_merchant_id),
    (SELECT COUNT(*) FROM vouchers WHERE merchant_id = p_merchant_id AND status = 'active'),
    (SELECT COUNT(*) FROM voucher_redemptions r JOIN vouchers v ON v.voucher_id = r.voucher_id WHERE v.merchant_id = p_merchant_id AND r.redeemed_at >= p_since),
    COALESCE((SELECT SUM(r.purchase_amount) FROM voucher_redemptions r JOIN vouchers v ON v.voucher_id = r.voucher_id WHERE v.merchant_id = p_merchant_id AND r.redeemed_at >= p_since), 0),
    COALESCE((SELECT SUM(r.discount_amount) FROM voucher_redemptions r JOIN vouchers v ON v.voucher_id = r.voucher_id WHERE v.merchant_id = p_merchant_id AND r.redeemed_at >= p_since), 0),
    (SELECT COUNT(DISTINCT r.member_id) FROM voucher_redemptions r JOIN vouchers v ON v.voucher_id = r.voucher_id WHERE v.merchant_id = p_merchant_id AND r.redeemed_at >= p_since);
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_voucher_active WHERE merchant_id = 'MCH-...' LIMIT 10;
-- SELECT * FROM v_voucher_stats;
-- SELECT * FROM get_voucher_stats('MCH-...', now() - INTERVAL '7 days');
-- ============================================================
