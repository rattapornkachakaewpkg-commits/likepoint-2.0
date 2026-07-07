-- ============================================================
-- Notification Service — PF-15 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: Multi-channel notifications (SMS/Email/Push/Line/Telegram) with templates + preferences
-- Bridges events from PF-7/8/9/10/11/12 → user-facing messages
-- ============================================================

BEGIN;

-- ============================================================
-- 1. notification_templates
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_templates (
  id BIGSERIAL PRIMARY KEY,
  template_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,                            -- sms | email | push | line | telegram
  subject TEXT,
  body TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tpl_channel ON notification_templates (channel, status);

-- ============================================================
-- 2. notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  notification_id TEXT UNIQUE NOT NULL,             -- NOTIF-{ts}-{seq}
  template_id TEXT NOT NULL REFERENCES notification_templates(template_id),
  template_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient_member_id UUID NOT NULL,
  to_address TEXT,                                  -- phone/email/device_id/line_id/chat_id
  subject TEXT,
  body TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_id TEXT,                                 -- provider's message id
  status TEXT NOT NULL DEFAULT 'sent',              -- sent | read | failed
  failure_reason TEXT,
  idempotency_key TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  actor TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications (recipient_member_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_channel ON notifications (channel, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications (status);
CREATE INDEX IF NOT EXISTS idx_notif_template ON notifications (template_id, sent_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_idem ON notifications (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 3. notification_preferences
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_preferences (
  id BIGSERIAL PRIMARY KEY,
  member_id UUID UNIQUE NOT NULL,
  opt_out JSONB NOT NULL DEFAULT '[]'::jsonb,     -- template_ids to skip
  channels JSONB NOT NULL DEFAULT '["sms","email","push","line","telegram"]'::jsonb,
  quiet_hours JSONB,                                -- { start: "22:00", end: "08:00" }
  language TEXT NOT NULL DEFAULT 'th',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 4. View: v_notification_dashboard
-- ============================================================
CREATE OR REPLACE VIEW v_notification_dashboard AS
SELECT
  channel,
  COUNT(*) AS total_sent,
  COUNT(*) FILTER (WHERE status = 'read') AS total_read,
  COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
  ROUND(COUNT(*) FILTER (WHERE status = 'read')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS read_rate_pct,
  COUNT(*) FILTER (WHERE sent_at >= now() - INTERVAL '7 days') AS sent_7d,
  COUNT(*) FILTER (WHERE sent_at >= now() - INTERVAL '24 hours') AS sent_24h
FROM notifications
GROUP BY channel;

-- ============================================================
-- 5. View: v_unread_notifications
-- ============================================================
CREATE OR REPLACE VIEW v_unread_notifications AS
SELECT
  n.recipient_member_id,
  COUNT(*) AS unread_count,
  MAX(n.sent_at) AS latest_unread_at
FROM notifications n
WHERE n.status = 'sent'
GROUP BY n.recipient_member_id;

-- ============================================================
-- 6. RLS
-- ============================================================
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- templates: public read, admin write
DROP POLICY IF EXISTS tpl_public_read ON notification_templates;
CREATE POLICY tpl_public_read ON notification_templates
  FOR SELECT USING (status = 'active');

DROP POLICY IF EXISTS tpl_admin_all ON notification_templates;
CREATE POLICY tpl_admin_all ON notification_templates
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS tpl_service_all ON notification_templates;
CREATE POLICY tpl_service_all ON notification_templates
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- notifications: member own
DROP POLICY IF EXISTS notif_own ON notifications;
CREATE POLICY notif_own ON notifications
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'member'
    AND recipient_member_id::text = current_setting('app.current_member_id', true)
  );

DROP POLICY IF EXISTS notif_admin_all ON notifications;
CREATE POLICY notif_admin_all ON notifications
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS notif_service_all ON notifications;
CREATE POLICY notif_service_all ON notifications
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- preferences: member own
DROP POLICY IF EXISTS pref_own ON notification_preferences;
CREATE POLICY pref_own ON notification_preferences
  FOR ALL
  USING (
    current_setting('app.current_role', true) = 'member'
    AND member_id::text = current_setting('app.current_member_id', true)
  );

DROP POLICY IF EXISTS pref_admin_all ON notification_preferences;
CREATE POLICY pref_admin_all ON notification_preferences
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS pref_service_all ON notification_preferences;
CREATE POLICY pref_service_all ON notification_preferences
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 7. Function: get_notification_stats(p_since)
-- ============================================================
CREATE OR REPLACE FUNCTION get_notification_stats(p_since TIMESTAMPTZ DEFAULT now() - INTERVAL '7 days')
RETURNS TABLE (
  total_sent BIGINT,
  total_read BIGINT,
  total_failed BIGINT,
  read_rate_pct NUMERIC,
  unique_recipients BIGINT,
  top_template TEXT
) AS $$
DECLARE
  v_total BIGINT;
  v_read BIGINT;
  v_failed BIGINT;
  v_unique BIGINT;
  v_top TEXT;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'read'), COUNT(*) FILTER (WHERE status = 'failed'), COUNT(DISTINCT recipient_member_id)
  INTO v_total, v_read, v_failed, v_unique
  FROM notifications WHERE sent_at >= p_since;

  SELECT template_name INTO v_top
  FROM notifications WHERE sent_at >= p_since
  GROUP BY template_name ORDER BY COUNT(*) DESC LIMIT 1;

  RETURN QUERY SELECT v_total, v_read, v_failed,
    CASE WHEN v_total > 0 THEN ROUND(v_read::NUMERIC / v_total * 100, 1) ELSE 0 END,
    v_unique, v_top;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_notification_dashboard;
-- SELECT * FROM v_unread_notifications LIMIT 10;
-- SELECT * FROM get_notification_stats(now() - INTERVAL '7 days');
-- ============================================================
