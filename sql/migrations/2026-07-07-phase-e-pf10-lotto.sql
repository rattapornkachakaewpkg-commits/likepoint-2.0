-- ============================================================
-- Lotto & Reward Engine — PF-10 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Weekly/Daily lotto rounds — ticket purchase + RNG draw + prize claim
-- Ties to PF-9 Basic plan (lotto_weekly feature) and Pro (lotto_daily)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. lotto_rounds — round metadata
-- ============================================================
CREATE TABLE IF NOT EXISTS lotto_rounds (
  id BIGSERIAL PRIMARY KEY,
  round_id TEXT UNIQUE NOT NULL,                    -- LOTTO-{ts}-{seq}
  merchant_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ticket_price NUMERIC(18,2) NOT NULL CHECK (ticket_price > 0),
  max_tickets INT NOT NULL CHECK (max_tickets > 0),
  tickets_sold INT NOT NULL DEFAULT 0,
  prize_pool NUMERIC(18,2) NOT NULL,
  draw_at TIMESTAMPTZ NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'weekly',         -- weekly | daily | monthly
  required_feature TEXT,                            -- e.g., 'lotto_weekly' (Basic sub)
  status TEXT NOT NULL DEFAULT 'open',              -- open | drawn | claimed | cancelled
  drawn_at TIMESTAMPTZ,
  winning_ticket_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tickets_sold <= max_tickets)
);

CREATE INDEX IF NOT EXISTS idx_lotto_merchant ON lotto_rounds (merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_lotto_status ON lotto_rounds (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_lotto_draw_at ON lotto_rounds (draw_at) WHERE status = 'open';

-- ============================================================
-- 2. lotto_tickets — per-member ticket purchase
-- ============================================================
CREATE TABLE IF NOT EXISTS lotto_tickets (
  id BIGSERIAL PRIMARY KEY,
  ticket_id TEXT UNIQUE NOT NULL,                   -- TKT-{ts}-{seq}
  round_id TEXT NOT NULL REFERENCES lotto_rounds(round_id) ON DELETE CASCADE,
  member_id UUID NOT NULL,
  ticket_number INT NOT NULL,                       -- 1..max_tickets
  lucky_code TEXT NOT NULL,                         -- 6-digit display code
  price_paid NUMERIC(18,2) NOT NULL,
  debit_txn_id TEXT,                                -- wallet txn for ticket price
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',            -- active | won | lost | cancelled | claimed
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(round_id, member_id)                       -- 1 ticket per member per round
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_idem ON lotto_tickets (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ticket_member ON lotto_tickets (member_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_round ON lotto_tickets (round_id, ticket_number);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON lotto_tickets (status);

-- ============================================================
-- 3. lotto_draws — draw history (audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS lotto_draws (
  id BIGSERIAL PRIMARY KEY,
  draw_id TEXT UNIQUE NOT NULL,                     -- DRAW-{ts}-{seq}
  round_id TEXT NOT NULL REFERENCES lotto_rounds(round_id),
  winning_ticket_id TEXT NOT NULL REFERENCES lotto_tickets(ticket_id),
  winning_member_id UUID NOT NULL,
  total_tickets INT NOT NULL,
  prize_amount NUMERIC(18,2) NOT NULL,
  drawn_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rng_method TEXT NOT NULL DEFAULT 'uniform_random',
  claimed BOOLEAN NOT NULL DEFAULT false,
  claimed_at TIMESTAMPTZ,
  credit_txn_id TEXT,
  actor TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_draw_round ON lotto_draws (round_id);
CREATE INDEX IF NOT EXISTS idx_draw_member ON lotto_draws (winning_member_id);
CREATE INDEX IF NOT EXISTS idx_draw_unclaimed ON lotto_draws (claimed) WHERE claimed = false;

-- ============================================================
-- 4. View: v_lotto_active_rounds — public list
-- ============================================================
CREATE OR REPLACE VIEW v_lotto_active_rounds AS
SELECT
  round_id,
  merchant_id,
  name,
  ticket_price,
  max_tickets,
  tickets_sold,
  max_tickets - tickets_sold AS tickets_remaining,
  prize_pool,
  draw_at,
  frequency,
  required_feature,
  EXTRACT(EPOCH FROM (draw_at - now())) / 3600 AS hours_until_draw,
  CASE
    WHEN tickets_sold >= max_tickets THEN 'sold_out'
    WHEN draw_at < now() THEN 'awaiting_draw'
    ELSE 'open'
  END AS display_status
FROM lotto_rounds
WHERE status = 'open'
ORDER BY draw_at ASC;

-- ============================================================
-- 5. View: v_lotto_member_history
-- ============================================================
CREATE OR REPLACE VIEW v_lotto_member_history AS
SELECT
  t.member_id,
  t.ticket_id,
  t.round_id,
  r.name AS round_name,
  r.draw_at,
  t.ticket_number,
  t.lucky_code,
  t.price_paid,
  t.status AS ticket_status,
  d.winning_ticket_id,
  CASE WHEN d.winning_ticket_id = t.ticket_id THEN d.prize_amount ELSE 0 END AS won_prize
FROM lotto_tickets t
JOIN lotto_rounds r ON r.round_id = t.round_id
LEFT JOIN lotto_draws d ON d.round_id = r.round_id;

-- ============================================================
-- 6. RLS
-- ============================================================
ALTER TABLE lotto_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE lotto_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE lotto_draws ENABLE ROW LEVEL SECURITY;

-- rounds (public can see open, admin all)
DROP POLICY IF EXISTS lotto_public_read ON lotto_rounds;
CREATE POLICY lotto_public_read ON lotto_rounds
  FOR SELECT USING (status = 'open');

DROP POLICY IF EXISTS lotto_admin_all ON lotto_rounds;
CREATE POLICY lotto_admin_all ON lotto_rounds
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS lotto_service_all ON lotto_rounds;
CREATE POLICY lotto_service_all ON lotto_rounds
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- tickets (member own, admin all, service all)
DROP POLICY IF EXISTS ticket_own ON lotto_tickets;
CREATE POLICY ticket_own ON lotto_tickets
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'member'
    AND member_id::text = current_setting('app.current_member_id', true)
  );

DROP POLICY IF EXISTS ticket_admin_all ON lotto_tickets;
CREATE POLICY ticket_admin_all ON lotto_tickets
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS ticket_service_all ON lotto_tickets;
CREATE POLICY ticket_service_all ON lotto_tickets
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- draws (public read winning_ticket_id, admin all, service all)
DROP POLICY IF EXISTS draw_public_read ON lotto_draws;
CREATE POLICY draw_public_read ON lotto_draws
  FOR SELECT USING (true);

DROP POLICY IF EXISTS draw_admin_all ON lotto_draws;
CREATE POLICY draw_admin_all ON lotto_draws
  FOR ALL USING (current_setting('app.current_role', true) IN ('admin', 'auditor'));

DROP POLICY IF EXISTS draw_service_all ON lotto_draws;
CREATE POLICY draw_service_all ON lotto_draws
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 7. Function: get_lotto_stats(p_merchant_id)
-- ============================================================
CREATE OR REPLACE FUNCTION get_lotto_stats(p_merchant_id TEXT)
RETURNS TABLE (
  open_rounds BIGINT,
  drawn_rounds BIGINT,
  total_tickets_sold BIGINT,
  total_revenue NUMERIC,
  total_prize NUMERIC,
  net_revenue NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM lotto_rounds WHERE merchant_id = p_merchant_id AND status = 'open'),
    (SELECT COUNT(*) FROM lotto_rounds WHERE merchant_id = p_merchant_id AND status IN ('drawn', 'claimed')),
    (SELECT COUNT(*) FROM lotto_tickets t JOIN lotto_rounds r ON r.round_id = t.round_id WHERE r.merchant_id = p_merchant_id),
    COALESCE((SELECT SUM(t.price_paid) FROM lotto_tickets t JOIN lotto_rounds r ON r.round_id = t.round_id WHERE r.merchant_id = p_merchant_id), 0),
    COALESCE((SELECT SUM(d.prize_amount) FROM lotto_draws d JOIN lotto_rounds r ON r.round_id = d.round_id WHERE r.merchant_id = p_merchant_id), 0),
    COALESCE((SELECT SUM(t.price_paid) FROM lotto_tickets t JOIN lotto_rounds r ON r.round_id = t.round_id WHERE r.merchant_id = p_merchant_id), 0) -
    COALESCE((SELECT SUM(d.prize_amount) FROM lotto_draws d JOIN lotto_rounds r ON r.round_id = d.round_id WHERE r.merchant_id = p_merchant_id), 0);
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_lotto_active_rounds LIMIT 10;
-- SELECT * FROM v_lotto_member_history WHERE member_id = 'uuid...' LIMIT 20;
-- SELECT * FROM get_lotto_stats('MCH-...');
-- ============================================================
