-- Recovery Engine — PF-19 (Phase E)
BEGIN;

CREATE TABLE IF NOT EXISTS recovery_requests (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  member_id UUID NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('phone', 'email')),
  contact TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT false,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recovery_member ON recovery_requests (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_expires ON recovery_requests (expires_at);

-- Add columns to members table (in prod migration)
-- ALTER TABLE members ADD COLUMN IF NOT EXISTS failed_recovery_attempts INT DEFAULT 0;
-- ALTER TABLE members ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
-- ALTER TABLE members ADD COLUMN IF NOT EXISTS security_questions JSONB;
-- ALTER TABLE members ADD COLUMN IF NOT EXISTS password_reset_at TIMESTAMPTZ;

ALTER TABLE recovery_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recovery_own ON recovery_requests;
CREATE POLICY recovery_own ON recovery_requests FOR ALL USING (current_setting('app.current_role', true) = 'service');
DROP POLICY IF EXISTS recovery_admin ON recovery_requests;
CREATE POLICY recovery_admin ON recovery_requests FOR ALL USING (current_setting('app.current_role', true) = 'admin');

COMMIT;
