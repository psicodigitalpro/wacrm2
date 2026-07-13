import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { connectInstance, setEvolutionWebhook, computeEvolutionWebhookSecret } from '@/lib/whatsapp/evolution-api'
import { decrypt } from '@/lib/whatsapp/encryption'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// A Baileys-style QR code is only valid briefly before WhatsApp rotates
// it; 60s is a conservative placeholder, same as uazapi's connect
// route. The UI re-polls status regardless of this value.
const QR_TTL_SECONDS = 60

/**
 * POST /api/whatsapp/config/evolution/connect
 *
 * Starts (or resumes) pairing for the account's already-saved Evolution
 * instance (base_url + instance_name + api_key must have been saved via
 * POST /api/whatsapp/config/evolution first). Also (re)registers the
 * inbound webhook, since re-pairing an instance can reset its webhook
 * config on some Evolution deployments. Returns the QR code / pairing
 * code for the Settings UI to render; the UI then polls
 * GET /api/whatsapp/config/evolution until status flips to connected.
 */
export async function POST() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('id, provider, evolution_base_url, evolution_instance_name, evolution_api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config for connect:', configError)
      return NextResponse.json({ error: 'Failed to fetch configuration' }, { status: 500 })
    }

    if (!config || config.provider !== 'evolution') {
      return NextResponse.json(
        { error: 'Save an Evolution base_url, instance_name and api_key first.' },
        { status: 400 },
      )
    }

    let apiKey: string
    try {
      apiKey = decrypt(config.evolution_api_key)
    } catch (err) {
      console.error('[whatsapp/config/evolution/connect] Key decryption failed:', err)
      return NextResponse.json(
        {
          error:
            'The stored API key cannot be decrypted with the current ENCRYPTION_KEY. Reset the configuration and re-save.',
        },
        { status: 400 },
      )
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
    if (siteUrl) {
      try {
        // The webhook URL is keyed by this config's own id (not the
        // instance name) so inbound delivery resolves to exactly one
        // account with a single lookup — instance names are chosen
        // per-account on self-hosted servers and aren't guaranteed
        // unique across different accounts' servers.
        await setEvolutionWebhook({
          baseUrl: config.evolution_base_url,
          apiKey,
          instanceName: config.evolution_instance_name,
          url: `${siteUrl.replace(/\/$/, '')}/api/whatsapp/webhook/evolution/${config.id}`,
          webhookHeaders: { 'x-webhook-secret': computeEvolutionWebhookSecret(config.id) },
        })
      } catch (err) {
        // Non-fatal — connecting still works without inbound delivery;
        // surfaced in logs so it's visible during setup/debugging.
        console.error('[whatsapp/config/evolution/connect] webhook registration failed:', err)
      }
    } else {
      console.warn(
        '[whatsapp/config/evolution/connect] NEXT_PUBLIC_SITE_URL is unset — skipping webhook registration, inbound messages will not be delivered.',
      )
    }

    let result
    try {
      result = await connectInstance({
        baseUrl: config.evolution_base_url,
        apiKey,
        instanceName: config.evolution_instance_name,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Evolution error'
      console.error('Evolution connect failed:', message)
      return NextResponse.json({ error: `Evolution error: ${message}` }, { status: 502 })
    }

    const qrExpiresAt = new Date(Date.now() + QR_TTL_SECONDS * 1000).toISOString()
    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update({
        qr_code: result.qrCode,
        qr_expires_at: qrExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id)

    if (updateError) {
      console.error('Error persisting Evolution QR code:', updateError)
      // Non-fatal — the frontend still gets the QR code in this response.
    }

    return NextResponse.json({
      qr_code: result.qrCode,
      pairing_code: result.pairingCode,
      status: result.status,
      qr_expires_at: qrExpiresAt,
    })
  } catch (error) {
    console.error('Error in whatsapp/config/evolution/connect POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
