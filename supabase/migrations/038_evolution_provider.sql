-- ============================================================
-- whatsapp_config: add Evolution API as a third provider
--
-- Follows the exact pattern of migration 037 (uazapi): a `provider`
-- discriminator plus nullable, provider-prefixed columns, rather than a
-- separate table. Evolution API (https://github.com/EvolutionAPI/evolution-api,
-- a Baileys-based, self-hostable gateway) is authenticated per-instance
-- via an `apikey` header — the `hash` value returned by POST
-- /instance/create — rather than the server's global admin key, so a
-- compromised row can't be used to control every instance on the
-- account's Evolution server.
--
-- Backward compatibility: existing rows are untouched (provider stays
-- whatever it already was); this only adds new nullable columns and
-- widens the CHECK constraints.
--
-- One provider per account: whatsapp_config_account_id_key (migration
-- 017) already enforces UNIQUE(account_id) — no new constraint needed.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- `whatsapp_config_provider_check` is Postgres's default auto-generated
-- name for a single-column CHECK added via `ADD COLUMN ... CHECK (...)`
-- (migration 037) — the standard `{table}_{column}_check` convention,
-- not a name we chose. Drop-and-recreate is the only way to widen a
-- CHECK's allowed values.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
    CHECK (provider IN ('meta', 'uazapi', 'evolution'));

-- Evolution-specific columns, all nullable.
--   evolution_base_url      — per-account Evolution server URL
--                              (self-hosted; this project does not
--                              assume one shared server for every account).
--   evolution_instance_name — the instance's name, used as the path
--                              segment for every Evolution API call
--                              (/message/sendText/{instanceName}, etc).
--   evolution_instance_id    — Evolution's internal instance id
--                              (instance.instanceId from /instance/create).
--   evolution_api_key        — the per-instance `hash` returned by
--                              /instance/create, AES-256-GCM encrypted
--                              the same way access_token/instance_token
--                              are (see src/lib/whatsapp/encryption.ts).
--   evolution_paired_phone   — the WhatsApp number once paired; this
--                              provider's analogue of Meta's
--                              phone_number_id / uazapi's paired_phone.
-- qr_code / qr_expires_at are already generic (added in migration 037,
-- not uazapi-namespaced) and are reused as-is for Evolution's QR flow.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_base_url TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS evolution_api_key TEXT,
  ADD COLUMN IF NOT EXISTS evolution_paired_phone TEXT;

-- Extend the provider/fields guard with a third branch. Existing rows
-- (meta or uazapi) already satisfy their own branch untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_chk'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      DROP CONSTRAINT whatsapp_config_provider_fields_chk;
  END IF;

  ALTER TABLE whatsapp_config
    ADD CONSTRAINT whatsapp_config_provider_fields_chk CHECK (
      (provider = 'meta'      AND phone_number_id IS NOT NULL AND access_token IS NOT NULL) OR
      (provider = 'uazapi'    AND instance_token IS NOT NULL AND instance_id IS NOT NULL) OR
      (provider = 'evolution' AND evolution_api_key IS NOT NULL AND evolution_instance_name IS NOT NULL)
    );
END $$;
