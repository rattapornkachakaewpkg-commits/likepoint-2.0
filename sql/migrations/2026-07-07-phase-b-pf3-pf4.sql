-- ===========================================
-- Phase B: PF-3 (Reward) + PF-4 (Event Bus) — SQL Migration
-- Date: 2026-07-07
-- Author: AliClaw (AI Co-Worker)
-- Branch: feature/phase-b-pf3-pf4-reward-event
-- Bug Refs: A3, A5, A6, A7, A12, A15, A19, A22, A42
-- ===========================================

-- ===========================================
-- 1. Reward Claims (PF-3)
-- Idempotency table — one row per claim_id
-- Status: PENDING → GRANTED | FAILED | NO_WIN
-- ===========================================
CREATE TABLE IF NOT EXISTS reward_claims (
  claim_id           VARCHAR(200) PRIMARY KEY,    -- e.g. 'daily-2026-07-07-P1234'
  wallet_id          UUID NOT NULL,
  member_id          UUID NOT NULL,
  amount             DECIMAL(18,2) NOT NULL,
  reward_type        VARCHAR(30) NOT NULL,        -- 'DAILY_CLAIM' | 'REFERRAL_BONUS' | 'EVENT_BONUS' | 'MIGRATION_BONUS'
  status             VARCHAR(20) DEFAULT 'PENDING',  -- 'PENDING' | 'GRANTED' | 'FAILED' | 'NO_WIN'
  attempts           INTEGER DEFAULT 0,
  last_error         TEXT,
  txn_id             UUID,                        -- links to point_transactions
  metadata           JSONB,                       -- game_id, tier, etc.
  granted_at         TIMESTAMP,
  failed_at          TIMESTAMP,
  recorded_at        TIMESTAMP,
  created_at         TIMESTAMP DEFAULT NOW(),
  updated_at         TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reward_status ON reward_claims(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reward_member ON reward_claims(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_wallet ON reward_claims(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_failed ON reward_claims(status, failed_at)
  WHERE status = 'FAILED';

-- ===========================================
-- 2. Daily Reward Batch Log (PF-3)
-- Tracks nightly batch runs for monitoring
-- ===========================================
CREATE TABLE IF NOT EXISTS reward_batch_log (
  batch_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date           DATE NOT NULL,
  total_members      INTEGER NOT NULL,
  granted            INTEGER DEFAULT 0,
  failed             INTEGER DEFAULT 0,
  already_processed  INTEGER DEFAULT 0,
  started_at         TIMESTAMP DEFAULT NOW(),
  completed_at       TIMESTAMP,
  triggered_by       VARCHAR(50) DEFAULT 'cron',  -- 'cron' | 'admin' | 'manual'
  notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_batch_date ON reward_batch_log(run_date DESC);

-- ===========================================
-- 3. Event Log (PF-4)
-- Every published event — for replay + audit
-- ===========================================
CREATE TABLE IF NOT EXISTS event_log (
  event_id           VARCHAR(200) PRIMARY KEY,
  topic              VARCHAR(100) NOT NULL,       -- 'phone.changed' | 'point.credited' | etc.
  payload            JSONB NOT NULL,
  published_at       TIMESTAMP DEFAULT NOW(),
  delivered_count    INTEGER DEFAULT 0,
  dlq_count          INTEGER DEFAULT 0,
  source             VARCHAR(50)                  -- 'ms24' | 'bct' | 'pp7' | 'likepoint'
);

CREATE INDEX IF NOT EXISTS idx_event_topic_time ON event_log(topic, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_source ON event_log(source, published_at DESC);

-- ===========================================
-- 4. Dead Letter Queue (PF-4)
-- Events that failed all retries — admin replay
-- ===========================================
CREATE TABLE IF NOT EXISTS event_dlq (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           VARCHAR(200) NOT NULL,
  topic              VARCHAR(100) NOT NULL,
  payload            JSONB NOT NULL,
  error_message      TEXT,
  attempts           INTEGER DEFAULT 0,
  failed_at          TIMESTAMP DEFAULT NOW(),
  replayed_at        TIMESTAMP,
  replayed_by        VARCHAR(100),
  status             VARCHAR(20) DEFAULT 'PENDING',  -- 'PENDING' | 'REPLAYED' | 'DISCARDED'
  UNIQUE(event_id, topic)
);

CREATE INDEX IF NOT EXISTS idx_dlq_status_time ON event_dlq(status, failed_at DESC)
  WHERE status = 'PENDING';

-- ===========================================
-- 5. Event Subscriber Registry (PF-4)
-- Tracks which handlers subscribe to which topics
-- ===========================================
CREATE TABLE IF NOT EXISTS event_subscribers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic              VARCHAR(100) NOT NULL,
  handler_name       VARCHAR(100) NOT NULL,       -- 'wallet-display' | 'reporting' | 'analytics'
  handler_module     VARCHAR(200) NOT NULL,       -- file path
  enabled            BOOLEAN DEFAULT true,
  max_retries        INTEGER DEFAULT 3,
  last_invoked_at    TIMESTAMP,
  total_invocations  BIGINT DEFAULT 0,
  total_failures     BIGINT DEFAULT 0,
  registered_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(topic, handler_name)
);

CREATE INDEX IF NOT EXISTS idx_subscriber_topic ON event_subscribers(topic) WHERE enabled = true;

-- ===========================================
-- 6. Reward Audit (PDPA compliance)
-- ===========================================
CREATE TABLE IF NOT EXISTS reward_audit (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id           VARCHAR(200) NOT NULL,
  action             VARCHAR(50) NOT NULL,        -- 'REWARD_GRANTED' | 'REWARD_FAILED' | 'REWARD_REPLAY' | 'DAILY_BATCH_COMPLETE'
  wallet_id          UUID,
  member_id          UUID,
  amount             DECIMAL(18,2),
  reward_type        VARCHAR(30),
  attempts           INTEGER,
  error              TEXT,
  triggered_by       VARCHAR(50),
  metadata           JSONB,
  bug_ref            VARCHAR(20),                 -- 'A6/A7/A12'
  created_at         TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reward_audit_claim ON reward_audit(claim_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reward_audit_action ON reward_audit(action, created_at DESC);

-- ===========================================
-- 7. Event Bus Health (monitoring)
-- ===========================================
CREATE OR REPLACE VIEW v_event_bus_health AS
SELECT
  topic,
  COUNT(*) AS total_events,
  SUM(delivered_count) AS total_delivered,
  SUM(dlq_count) AS total_dlq,
  MAX(published_at) AS last_event_at,
  DATE_TRUNC('hour', published_at) AS hour
FROM event_log
WHERE published_at > NOW() - INTERVAL '24 hours'
GROUP BY topic, DATE_TRUNC('hour', published_at)
ORDER BY hour DESC, topic;

-- ===========================================
-- 8. Sample seed data for demo page
-- ===========================================
-- (Demo only — production uses real data)

COMMENT ON TABLE reward_claims IS
'Phase B: PF-3 — Idempotent reward claims with retry. Bug A6 (Lock&Earn Android), A7 (auto script), A12 (daily reward not entering).';

COMMENT ON TABLE reward_batch_log IS
'Phase B: PF-3 — Tracks nightly batch runs for monitoring.';

COMMENT ON TABLE event_log IS
'Phase B: PF-4 — In-memory event bus persistence (replaces AWS SQS in dev). Bug A3/A5/A15/A19/A22/A42 (cross-system sync).';

COMMENT ON TABLE event_dlq IS
'Phase B: PF-4 — Dead letter queue for failed event handlers. Admin can replay.';

COMMENT ON TABLE event_subscribers IS
'Phase B: PF-4 — Registry of event subscribers for monitoring + discovery.';

COMMENT ON TABLE reward_audit IS
'Phase B: PF-3 — Audit trail for all reward operations (PDPA).';
