import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { connectInstance } from '@/lib/whatsapp/uazapi-api'
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

// A uazapi/Baileys-style QR code is only valid briefly before WhatsApp
// rotates it; 60s is a conservative placeholder until confirmed against
// a live instance (see uazapi-api.ts's header note on unconfirmed
// response shapes). The UI re-polls status regardless of this value.
const QR_TTL_SECONDS = 60

/**
 * POST /api/whatsapp/config/uazapi/connect
 *
 * Starts (or resumes) pairing for the account's already-saved uazapi
 * instance (base_url + instance_token must have been saved via
 * POST /api/whatsapp/config/uazapi first). Returns the QR code /
 * pairing code for the Settings UI to render; the UI then polls
 * GET /api/whatsapp/config/uazapi until status flips to connected.
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
      .select('id, provider, base_url, instance_token, instance_name')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config for connect:', configError)
      return NextResponse.json({ error: 'Failed to fetch configuration' }, { status: 500 })
    }

    if (!config || config.provider !== 'uazapi') {
      return NextResponse.json(
        { error: 'Save a uazapi base_url and instance_token first.' },
        { status: 400 },
      )
    }

    let instanceToken: string
    try {
      instanceToken = decrypt(config.instance_token)
    } catch (err) {
      console.error('[whatsapp/config/uazapi/connect] Token decryption failed:', err)
      return NextResponse.json(
        {
          error:
            'The stored instance token cannot be decrypted with the current ENCRYPTION_KEY. Reset the configuration and re-save.',
        },
        { status: 400 },
      )
    }

    let result
    try {
      result = await connectInstance({
        baseUrl: config.base_url,
        instanceToken,
        systemName: config.instance_name || undefined,
        browser: 'auto',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown uazapi error'
      console.error('uazapi connect failed:', message)
      return NextResponse.json({ error: `uazapi error: ${message}` }, { status: 502 })
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
      console.error('Error persisting uazapi QR code:', updateError)
      // Non-fatal — the frontend still gets the QR code in this response.
    }

    return NextResponse.json({
      qr_code: result.qrCode,
      pairing_code: result.pairingCode,
      status: result.status,
      qr_expires_at: qrExpiresAt,
    })
  } catch (error) {
    console.error('Error in whatsapp/config/uazapi/connect POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
