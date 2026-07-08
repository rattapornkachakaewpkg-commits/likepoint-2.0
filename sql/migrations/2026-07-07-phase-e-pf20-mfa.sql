-- MFA Engine — PF-20 (Phase E)
BEGIN;

CREATE TABLE IF NOT EXISTS mfa_factors (
  id BIGSERIAL PRIMARY KEY,
  factor_id TEXT UNIQUE NOT NULL,
  member_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('totp', 'sms', 'biometric', 'sms-otp')),
  device_name TEXT,
  device_id TEXT,
  biometric_type TEXT,
  public_key TEXT,
  secret TEXT,  -- TOTP secret (encrypted in prod)
  phone TEXT,
  expires_at TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_mfa_member ON mfa_factors (member_id, status);
CREATE INDEX IF NOT EXISTS idx_mfa_type ON mfa_factors (type) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id BIGSERIAL PRIMARY KEY,
  code_hash TEXT UNIQUE NOT NULL,
  member_id UUID NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_member ON mfa_recovery_codes (member_id, used_at);

CREATE TABLE IF NOT EXISTS trusted_devices (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT UNIQUE NOT NULL,
  member_id UUID NOT NULL,
  biometric_type TEXT,
  trusted BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY mfa_own ON mfa_factors FOR ALL USING (
  current_setting('app.current_role', true) = 'member'
  AND member_id::text = current_setting('app.current_member_id', true)
);
CREATE POLICY mfa_admin ON mfa_factors FOR ALL USING (current_setting('app.current_role', true) = 'admin');
CREATE POLICY mfa_service ON mfa_factors FOR ALL USING (current_setting('app.current_role', true) = 'service');

COMMIT;
