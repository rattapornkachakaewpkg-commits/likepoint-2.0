-- ===========================================
-- P0: Identity Service Schema (RFC-001)
-- Date: 2026-07-07
-- Author: AliClaw
-- RFC-001: "Platform จะสร้าง Member ID แบบ UUID ตั้งแต่การสมัครครั้งแรก"
-- ===========================================

-- Platform Member (canonical identity)
CREATE TABLE IF NOT EXISTS members (
  member_id       UUID PRIMARY KEY,
  display_name    VARCHAR(255) NOT NULL,
  status          VARCHAR(20) DEFAULT 'ACTIVE',  -- 'ACTIVE' | 'SUSPENDED' | 'DELETED'
  trust_score     INTEGER DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  kyc_level       VARCHAR(20) DEFAULT 'LEVEL_0',  -- 'LEVEL_0' | 'LEVEL_1' | 'LEVEL_2'
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  deleted_at      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_members_status ON members(status) WHERE status != 'DELETED';
CREATE INDEX IF NOT EXISTS idx_members_created ON members(created_at);

-- Phone Bindings (RFC-001 Open Question #2: multi-phone)
CREATE TABLE IF NOT EXISTS phone_bindings (
  binding_id      UUID PRIMARY KEY,
  member_id       UUID NOT NULL REFERENCES members(member_id),
  phone_hash      VARCHAR(128) NOT NULL,
  phone_last4     VARCHAR(4),
  status          VARCHAR(30) DEFAULT 'PENDING',  -- 'PENDING' | 'VERIFIED' | 'PRIMARY_VERIFIED' | 'SECONDARY' | 'REVOKED'
  is_primary      BOOLEAN DEFAULT false,
  verified_at     TIMESTAMP,
  revoked_at      TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  
  -- 1 phone_hash ต่อ member เดียว (no duplicate)
  UNIQUE(phone_hash)
);

CREATE INDEX IF NOT EXISTS idx_phone_bindings_member ON phone_bindings(member_id);
CREATE INDEX IF NOT EXISTS idx_phone_bindings_primary ON phone_bindings(member_id, is_primary) WHERE is_primary = true;
CREATE INDEX IF NOT EXISTS idx_phone_bindings_hash ON phone_bindings(phone_hash);

-- Device Bindings (RFC-001: การจัดการผู้ใช้ที่เปลี่ยนเครื่อง)
CREATE TABLE IF NOT EXISTS device_bindings (
  device_id       UUID PRIMARY KEY,
  member_id       UUID NOT NULL REFERENCES members(member_id),
  device_fingerprint VARCHAR(255) NOT NULL,
  platform        VARCHAR(20),  -- 'ios' | 'android' | 'web'
  app_version     VARCHAR(50),
  last_seen_at    TIMESTAMP DEFAULT NOW(),
  first_seen_at   TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(member_id, device_fingerprint)
);

-- Login History
CREATE TABLE IF NOT EXISTS login_history (
  id              BIGSERIAL PRIMARY KEY,
  member_id       UUID NOT NULL,
  phone_hash      VARCHAR(128),
  login_at        TIMESTAMP DEFAULT NOW(),
  ip_address      VARCHAR(45),
  user_agent      TEXT,
  result          VARCHAR(20),  -- 'SUCCESS' | 'FAILED'
  failure_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_history_member ON login_history(member_id, login_at DESC);

-- Consent Log (PDPA)
CREATE TABLE IF NOT EXISTS consent_log (
  consent_id      UUID PRIMARY KEY,
  member_id       UUID NOT NULL REFERENCES members(member_id),
  consent_type    VARCHAR(50) NOT NULL,  -- 'MARKETING' | 'DATA_PROCESSING' | 'THIRD_PARTY_SHARING'
  granted         BOOLEAN NOT NULL,
  granted_at      TIMESTAMP,
  revoked_at      TIMESTAMP,
  ip_address      VARCHAR(45),
  user_agent      TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_member ON consent_log(member_id, consent_type);
CREATE INDEX IF NOT EXISTS idx_consent_granted ON consent_log(consent_type) WHERE granted = true;

-- Comments
COMMENT ON TABLE members IS 'RFC-001 P0: Platform Member (canonical identity with UUID)';
COMMENT ON TABLE phone_bindings IS 'RFC-001 P0: 1 Member can have multiple phone bindings';
COMMENT ON TABLE device_bindings IS 'RFC-001 P0: Track device changes (Open Question #3)';
COMMENT ON TABLE login_history IS 'RFC-001 P0: Login audit trail';
COMMENT ON TABLE consent_log IS 'RFC-001 P0: PDPA consent log';

-- Rollback
-- DROP TABLE IF EXISTS consent_log;
-- DROP TABLE IF EXISTS login_history;
-- DROP TABLE IF EXISTS device_bindings;
-- DROP TABLE IF EXISTS phone_bindings;
-- DROP TABLE IF EXISTS members;
