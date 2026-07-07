-- ============================================================
-- Gift Card Engine — PF-11 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Gift cards: no expiry, transferable, redeemable at any merchant
-- Based on Likepoint meeting 16/12/2022: "Gift Card (ของขวัญ) ออกได้ทั้ง SME และ User"
-- ============================================================

BEGIN;

-- ============================================================
-- 1. gift_cards
-- ============================================================
CREATE TABLE IF NOT EXISTS gift_cards (
  id BIGSERIAL PRIMARY KEY,
  card_id TEXT UNIQUE NOT NULL,                     -- GC-{ts}-{seq}
  code TEXT UNIQUE NOT NULL,                        -- XXXX-XXXX-XXXX-XXXX (16-char, user shares)
  pin_hash TEXT NOT NULL,                           -- bcrypt/argon2 of 6-digit PIN (in prod)
  merchant_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  balance NUMERIC(18,2) NOT NULL,                  -- for partial redeem (future)
  issued_by UUID NOT NULL,                          -- member who paid
  recipient_member_id UUID,                        -- optional target
  recipient_phone TEXT,
  message TEXT,
  design TEXT DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'active',            -- active | redeemed | voided | transferred
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,                          -- NULL = no expiry (gift cards are permanent)
  redeemed_at TIMESTAMPTZ,
  redeemed_by UUID,
  transferred_at TIMESTAMPTZ,
  transferred_from UUID,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  idempotency_key TEXT,
  debit_txn_id TEXT,                               -- wallet txn for issue charge
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gc_merchant ON gift_cards (merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_gc_issued_by ON gift_cards (issued_by, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_gc_recipient ON gift_cards (recipient_member_id) WHERE recipient_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gc_redeemed_by ON gift_cards (redeemed_by) WHERE redeemed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gc_status ON gift_cards (status) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_gc_idem ON gift_cards (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 2. gift_card_transactions
-- ============================================================
CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id BIGSERIAL PRIMARY KEY,
  txn_id TEXT UNIQUE NOT NULL,                      -- GIFT-TX-{ts}-{seq}
  card_id TEXT NOT NULL REFERENCES gift_cards(card_id) ON DELETE CASCADE,
  type TEXT NOT NULL,                               -- ISSUE | REDEEM | TRANSFER | VOID
  member_id UUID NOT NULL,                          -- who initiated
  to_member_id UUID,                               -- for TRANSFER
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,         -- 0 for transfer
  txn_ref TEXT,                                    -- related wallet txn
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gctx_card ON gift_card_transactions (card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gctx_member ON gift_card_transactions (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gctx_type ON gift_card_transactions (type);

-- ============================================================
-- 3. View: v_gift_card_dashboard
-- ============================================================
CREATE OR REPLACE VIEW v_gift_card_dashboard AS
SELECT
  merchant_id,
  COUNT(*) AS total_cards,
  COUNT(*) FILTER (WHERE status = 'active') AS active_cards,
  COUNT(*) FILTER (WHERE status = 'redeemed') AS redeemed_cards,
  COUNT(*) FILTER (WHERE status = 'voided') AS voided_cards,
  COALESCE(SUM(amount) FILTER (WHERE status = 'redeemed'), 0) AS total_redeemed_amount,
  COALESCE(SUM(fee), 0) AS total_fees_collected,
  COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0) AS outstanding_liability
FROM gift_cards
GROUP BY merchant_id;

-- ============================================================
-- 4. View: v_gift_card_member_history
-- ============================================================
CREATE OR REPLACE VIEW v_gift_card_member_history AS
SELECT
  c.card_id,
  c.code,
  c.merchant_id,
  c.amount,
  c.message,
  c.issued_at,
  c.redeemed_at,
  c.status,
  CASE
    WHEN c.issued_by = c.redeemed_by THEN 'self'
    WHEN c.recipient_member_id IS NOT NULL AND c.recipient_member_id = c.redeemed_by THEN 'target'
    WHEN c.issued_by = c.redeemed_by THEN 'self'
    ELSE 'gift'
  END AS flow_type
FROM gift_cards c
WHERE c.redeemed_by IS NOT NULL OR c.issued_by IS NOT NULL;

-- ============================================================
-- 5. RLS
-- ============================================================
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_card_transactions ENABLE ROW LEVEL SECURITY;

-- cards: member sees own (issued or received)
DROP POLICY IF EXISTS gc_member_own ON gift_cards;
CREATE POLICY gc_member_own ON gift_cards
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'member'
    AND (
      issued_by::text = current_setting('app.current_member_id', true)
      OR recipient_member_id::text = current_setting('app.current_member_id', true)
      OR redeemed_by::text = current_setting('app.current_member_id', true)
    )
  );

DROP POLICY IF EXISTS gc_admin_all ON gift_cards;
CREATE POLICY gc_admin_all ON gift_cards
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS gc_service_all ON gift_cards;
CREATE POLICY gc_service_all ON gift_cards
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- transactions: member sees own
DROP POLICY IF EXISTS gctx_own ON gift_card_transactions;
CREATE POLICY gctx_own ON gift_card_transactions
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'member'
    AND (
      member_id::text = current_setting('app.current_member_id', true)
      OR to_member_id::text = current_setting('app.current_member_id', true)
    )
  );

DROP POLICY IF EXISTS gctx_admin_all ON gift_card_transactions;
CREATE POLICY gctx_admin_all ON gift_card_transactions
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS gctx_service_all ON gift_card_transactions;
CREATE POLICY gctx_service_all ON gift_card_transactions
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 6. Function: get_gift_card_stats(merchant_id, since)
-- ============================================================
CREATE OR REPLACE FUNCTION get_gift_card_stats(p_merchant_id TEXT, p_since TIMESTAMPTZ DEFAULT now() - INTERVAL '7 days')
RETURNS TABLE (
  cards_issued BIGINT,
  cards_redeemed BIGINT,
  total_volume NUMERIC,
  total_revenue NUMERIC,
  redemption_rate NUMERIC
) AS $$
DECLARE
  v_issued BIGINT;
  v_redeemed BIGINT;
  v_volume NUMERIC;
  v_revenue NUMERIC;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0), COALESCE(SUM(fee), 0)
  INTO v_issued, v_volume, v_revenue
  FROM gift_cards WHERE merchant_id = p_merchant_id AND issued_at >= p_since;
  SELECT COUNT(*)
  INTO v_redeemed
  FROM gift_cards WHERE merchant_id = p_merchant_id AND status = 'redeemed' AND redeemed_at >= p_since;
  RETURN QUERY SELECT v_issued, v_redeemed, v_volume, v_revenue,
    CASE WHEN v_issued > 0 THEN (v_redeemed::NUMERIC / v_issued * 100) ELSE 0 END;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_gift_card_dashboard;
-- SELECT * FROM v_gift_card_member_history WHERE issued_by = 'uuid...' LIMIT 20;
-- SELECT * FROM get_gift_card_stats('MCH-...', now() - INTERVAL '7 days');
-- ============================================================
