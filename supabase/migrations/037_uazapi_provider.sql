-- ============================================================
-- whatsapp_config: add uazapi as a second provider
--
-- Until now every whatsapp_config row assumed the Meta WhatsApp Cloud
-- API (phone_number_id + waba_id + access_token). This adds a
-- `provider` discriminator plus nullable columns for uazapi — an
-- unofficial, QR-code-paired gateway — so an account can connect via
-- either provider.
--
-- Backward compatibility: every existing row gets `provider = 'meta'`
-- via the column DEFAULT, and its existing Meta columns are untouched.
-- No re-auth, no re-save, no behavior change for current users.
--
-- One provider per account: whatsapp_config_account_id_key (added in
-- migration 017) already enforces UNIQUE(account_id), so switching an
-- account's provider is just updating that one row — no new
-- constraint needed for that invariant.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'uazapi'));

-- Meta-only columns become optional — a uazapi row has neither.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- uazapi-specific columns, all nullable.
--   base_url        — per-account instance URL (self-hosted or a paid
--                      uazapi instance); this project does not assume
--                      one shared server for every account.
--   instance_id      — uazapi's identifier for the paired session.
--   instance_token    — uazapi's auth token for this instance, AES-256-
--                      GCM encrypted the same way access_token is
--                      (see src/lib/whatsapp/encryption.ts).
--   instance_name     — the `systemName` label shown during pairing.
--   paired_phone      — the WhatsApp number once paired; this is
--                      uazapi's analogue of Meta's phone_number_id for
--                      resolving which account owns an inbound webhook.
--   qr_code           — last QR code payload returned by /instance/connect,
--                      shown in Settings until the user finishes pairing.
--   qr_expires_at     — the QR code's validity deadline.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS base_url TEXT,
  ADD COLUMN IF NOT EXISTS instance_id TEXT,
  ADD COLUMN IF NOT EXISTS instance_token TEXT,
  ADD COLUMN IF NOT EXISTS instance_name TEXT,
  ADD COLUMN IF NOT EXISTS paired_phone TEXT,
  ADD COLUMN IF NOT EXISTS qr_code TEXT,
  ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMPTZ;

-- Guard against a half-saved row: a 'meta' row must carry the Meta
-- identity columns, a 'uazapi' row must carry the uazapi ones. Every
-- pre-existing row already satisfies the 'meta' branch (phone_number_id
-- and access_token were NOT NULL before this migration), so this is a
-- no-op for existing data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_chk'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_fields_chk CHECK (
        (provider = 'meta'   AND phone_number_id IS NOT NULL AND access_token IS NOT NULL) OR
        (provider = 'uazapi' AND instance_token IS NOT NULL AND instance_id IS NOT NULL)
      );
  END IF;
END $$;
