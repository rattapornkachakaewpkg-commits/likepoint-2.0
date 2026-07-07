-- ============================================================
-- Multi-language (i18n) Engine — PF-18 (Phase E)
-- Date: 2026-07-07
-- Author: AliClaw
-- Purpose: 4-locale translation support (th/en/kh/la) + locale-specific formatting
-- Based on Likepoint meeting 12/01/2023: 4 locales
-- ============================================================

BEGIN;

-- ============================================================
-- 1. i18n_translations
-- ============================================================
CREATE TABLE IF NOT EXISTS i18n_translations (
  id BIGSERIAL PRIMARY KEY,
  translation_key TEXT NOT NULL,                    -- e.g., 'greeting.hello', 'error.payment_failed'
  locale TEXT NOT NULL CHECK (locale IN ('th', 'en', 'kh', 'la')),
  value TEXT NOT NULL,
  context TEXT,                                     -- e.g., 'button', 'error', 'email_subject'
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(translation_key, locale)
);

CREATE INDEX IF NOT EXISTS idx_i18n_key ON i18n_translations (translation_key);
CREATE INDEX IF NOT EXISTS idx_i18n_locale ON i18n_translations (locale, status);
CREATE INDEX IF NOT EXISTS idx_i18n_context ON i18n_translations (context) WHERE context IS NOT NULL;

-- ============================================================
-- 2. View: v_i18n_coverage
-- ============================================================
CREATE OR REPLACE VIEW v_i18n_coverage AS
SELECT
  translation_key,
  COUNT(*) FILTER (WHERE locale = 'th') AS has_th,
  COUNT(*) FILTER (WHERE locale = 'en') AS has_en,
  COUNT(*) FILTER (WHERE locale = 'kh') AS has_kh,
  COUNT(*) FILTER (WHERE locale = 'la') AS has_la,
  (COUNT(*) FILTER (WHERE locale = 'th')::INT + COUNT(*) FILTER (WHERE locale = 'en')::INT + COUNT(*) FILTER (WHERE locale = 'kh')::INT + COUNT(*) FILTER (WHERE locale = 'la')::INT) AS total_locales
FROM i18n_translations
WHERE status = 'active'
GROUP BY translation_key;

-- ============================================================
-- 3. View: v_i18n_stats
-- ============================================================
CREATE OR REPLACE VIEW v_i18n_stats AS
SELECT
  locale,
  COUNT(*) AS translation_count,
  COUNT(DISTINCT translation_key) AS unique_keys,
  COUNT(*) FILTER (WHERE context = 'button') AS button_count,
  COUNT(*) FILTER (WHERE context = 'error') AS error_count,
  COUNT(*) FILTER (WHERE context = 'email') AS email_count,
  COUNT(*) FILTER (WHERE context = 'notification') AS notification_count
FROM i18n_translations
WHERE status = 'active'
GROUP BY locale;

-- ============================================================
-- 4. RLS
-- ============================================================
ALTER TABLE i18n_translations ENABLE ROW LEVEL SECURITY;

-- Translations: public can read (for UI), admin can write
DROP POLICY IF EXISTS i18n_public_read ON i18n_translations;
CREATE POLICY i18n_public_read ON i18n_translations
  FOR SELECT USING (status = 'active');

DROP POLICY IF EXISTS i18n_admin_all ON i18n_translations;
CREATE POLICY i18n_admin_all ON i18n_translations
  FOR ALL USING (current_setting('app.current_role', true) = 'admin');

DROP POLICY IF EXISTS i18n_service_all ON i18n_translations;
CREATE POLICY i18n_service_all ON i18n_translations
  FOR ALL USING (current_setting('app.current_role', true) = 'service');

-- ============================================================
-- 5. Seed: common translations for 4 locales
-- ============================================================
INSERT INTO i18n_translations (translation_key, locale, value, context) VALUES
  -- Greetings
  ('greeting.hello', 'th', 'สวัสดี', 'greeting'),
  ('greeting.hello', 'en', 'Hello', 'greeting'),
  ('greeting.hello', 'kh', 'ជំរាបសួស', 'greeting'),
  ('greeting.hello', 'la', 'ສະບາຍດີ', 'greeting'),
  ('greeting.welcome', 'th', 'ยินดีต้อนรับ {{name}}', 'greeting'),
  ('greeting.welcome', 'en', 'Welcome {{name}}', 'greeting'),
  ('greeting.welcome', 'kh', 'សូមស្វាគមមក {{name}}', 'greeting'),
  ('greeting.welcome', 'la', 'ຍິນດີຕ້ອນຮັບ {{name}}', 'greeting'),
  -- Errors
  ('error.payment_failed', 'th', 'การชำระเงินล้มเหลว กรุณาลองใหม่', 'error'),
  ('error.payment_failed', 'en', 'Payment failed. Please try again.', 'error'),
  ('error.payment_failed', 'kh', 'ការទូទាត់បានបរាជ័យ។ សូមព្យាយាម្តងទៀត។', 'error'),
  ('error.payment_failed', 'la', 'ການຈ່າຍເງິນບໍ່ສຳເລັດ ກະລຸນາລອງໃໝ່', 'error'),
  -- Buttons
  ('button.submit', 'th', 'ส่ง', 'button'),
  ('button.submit', 'en', 'Submit', 'button'),
  ('button.submit', 'kh', 'ដាក់ស្នើ', 'button'),
  ('button.submit', 'la', 'ສົ່ງ', 'button'),
  -- Notifications
  ('notif.poi.reward', 'th', 'คุณได้รับ {{amount}} BCP จากกิจกรรม {{event}}', 'notification'),
  ('notif.poi.reward', 'en', 'You received {{amount}} BCP from {{event}}', 'notification'),
  ('notif.poi.reward', 'kh', 'អ្នកបានទទួល {{amount}} BCP ពី {{event}}', 'notification'),
  ('notif.poi.reward', 'la', 'ທ່ານໄດ້ຮັບ {{amount}} BCP ຈາກ {{event}}', 'notification')
ON CONFLICT (translation_key, locale) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;

-- ============================================================
-- Post-deploy verification:
-- SELECT * FROM v_i18n_coverage WHERE total_locales < 4;
-- SELECT * FROM v_i18n_stats;
-- ============================================================
