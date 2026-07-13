/**
 * Shared whatsapp_config loader — mirrors src/lib/ai/config.ts's
 * loadAiConfig. Every outbound-send call site used to repeat the same
 * `select('*').eq('account_id', ...)` + decrypt + legacy-format self-heal
 * inline; this centralizes it so adding uazapi didn't mean adding a
 * second copy of that boilerplate at every site.
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook —
 * same convention as loadAiConfig.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from './encryption'
import type { WhatsAppProvider } from '@/types'

export interface ResolvedWhatsAppConfig {
  id: string
  accountId: string
  userId: string
  provider: WhatsAppProvider

  // ---- meta ----
  phoneNumberId?: string
  wabaId?: string
  /** Decrypted. */
  accessToken?: string

  // ---- uazapi ----
  baseUrl?: string
  instanceId?: string
  /** Decrypted. */
  instanceToken?: string
  pairedPhone?: string

  // ---- evolution ----
  evolutionBaseUrl?: string
  evolutionInstanceName?: string
  evolutionInstanceId?: string
  /** Decrypted. */
  evolutionApiKey?: string
  evolutionPairedPhone?: string
}

interface WhatsAppConfigRow {
  id: string
  account_id: string
  user_id: string
  provider: WhatsAppProvider
  phone_number_id: string | null
  waba_id: string | null
  access_token: string | null
  base_url: string | null
  instance_id: string | null
  instance_token: string | null
  paired_phone: string | null
  evolution_base_url: string | null
  evolution_instance_name: string | null
  evolution_instance_id: string | null
  evolution_api_key: string | null
  evolution_paired_phone: string | null
}

const CONFIG_COLUMNS =
  'id, account_id, user_id, provider, phone_number_id, waba_id, access_token, base_url, instance_id, instance_token, paired_phone, evolution_base_url, evolution_instance_name, evolution_instance_id, evolution_api_key, evolution_paired_phone'

/**
 * Load whatsapp_config for an account and decrypt whichever token the
 * row's provider actually uses. Returns `null` when there's no row —
 * callers treat that as "WhatsApp not configured", same as before this
 * helper existed.
 */
export async function loadWhatsAppConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<ResolvedWhatsAppConfig | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as unknown as WhatsAppConfigRow

  const resolved: ResolvedWhatsAppConfig = {
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    provider: row.provider,
  }

  if (row.provider === 'uazapi') {
    resolved.baseUrl = row.base_url ?? undefined
    resolved.instanceId = row.instance_id ?? undefined
    resolved.pairedPhone = row.paired_phone ?? undefined
    if (row.instance_token) {
      resolved.instanceToken = decrypt(row.instance_token)
      // Self-heal legacy CBC ciphertexts, same as access_token below.
      if (isLegacyFormat(row.instance_token)) {
        void db
          .from('whatsapp_config')
          .update({ instance_token: encrypt(resolved.instanceToken) })
          .eq('id', row.id)
          .then(({ error: updateError }: { error: { message: string } | null }) => {
            if (updateError) {
              console.warn('[provider-config] instance_token GCM upgrade failed:', updateError.message)
            }
          })
      }
    }
    return resolved
  }

  if (row.provider === 'evolution') {
    resolved.evolutionBaseUrl = row.evolution_base_url ?? undefined
    resolved.evolutionInstanceName = row.evolution_instance_name ?? undefined
    resolved.evolutionInstanceId = row.evolution_instance_id ?? undefined
    resolved.evolutionPairedPhone = row.evolution_paired_phone ?? undefined
    if (row.evolution_api_key) {
      resolved.evolutionApiKey = decrypt(row.evolution_api_key)
      // Self-heal legacy CBC ciphertexts, same as access_token/instance_token below.
      if (isLegacyFormat(row.evolution_api_key)) {
        void db
          .from('whatsapp_config')
          .update({ evolution_api_key: encrypt(resolved.evolutionApiKey) })
          .eq('id', row.id)
          .then(({ error: updateError }: { error: { message: string } | null }) => {
            if (updateError) {
              console.warn('[provider-config] evolution_api_key GCM upgrade failed:', updateError.message)
            }
          })
      }
    }
    return resolved
  }

  // provider === 'meta'
  resolved.phoneNumberId = row.phone_number_id ?? undefined
  resolved.wabaId = row.waba_id ?? undefined
  if (row.access_token) {
    resolved.accessToken = decrypt(row.access_token)
    if (isLegacyFormat(row.access_token)) {
      void db
        .from('whatsapp_config')
        .update({ access_token: encrypt(resolved.accessToken) })
        .eq('id', row.id)
        .then(({ error: updateError }: { error: { message: string } | null }) => {
          if (updateError) {
            console.warn('[provider-config] access_token GCM upgrade failed:', updateError.message)
          }
        })
    }
  }
  return resolved
}
