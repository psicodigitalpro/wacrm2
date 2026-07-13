import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getInstanceStatus } from '@/lib/whatsapp/evolution-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile. Mirrors the
 * helper in ../uazapi/route.ts and ../route.ts (Meta's config route) —
 * kept duplicated rather than shared since all three routes are small
 * and otherwise independent.
 */
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * GET /api/whatsapp/config/evolution
 *
 * Health check for the Evolution connection, used the same way the
 * Meta/uazapi routes' GET is used by "Test Connection". Returns 200 in
 * every non-auth case so the UI can render a message instead of a 500.
 */
export async function GET() {
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
        { connected: false, reason: 'no_account', message: 'Your profile is not linked to an account.' },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('provider, evolution_base_url, evolution_instance_name, evolution_api_key, evolution_paired_phone')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 },
      )
    }

    if (!config || config.provider !== 'evolution') {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No Evolution configuration saved yet.',
        },
        { status: 200 },
      )
    }

    let apiKey: string
    try {
      apiKey = decrypt(config.evolution_api_key)
    } catch (err) {
      console.error('[whatsapp/config/evolution GET] Key decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored API key cannot be decrypted with the current ENCRYPTION_KEY. Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 },
      )
    }

    try {
      const status = await getInstanceStatus({
        baseUrl: config.evolution_base_url,
        apiKey,
        instanceName: config.evolution_instance_name,
      })
      return NextResponse.json({
        connected: status.connected,
        status: status.status,
        phone: status.phone ?? config.evolution_paired_phone ?? null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Evolution error'
      console.error('[whatsapp/config/evolution GET] status check failed:', message)
      return NextResponse.json(
        { connected: false, reason: 'evolution_api_error', message: `Evolution rejected the request: ${message}` },
        { status: 200 },
      )
    }
  } catch (error) {
    console.error('Error in whatsapp/config/evolution GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/whatsapp/config/evolution
 *
 * Saves the account's Evolution connection (base_url + instance_name +
 * a per-instance apikey the user already created via their Evolution
 * server/manager UI). Verifies the credentials against Evolution first,
 * then encrypts and stores. Switching an account's provider is
 * destructive by design — whatsapp_config is one row per account
 * (UNIQUE(account_id), migration 017), so this overwrites whichever
 * provider was previously configured.
 */
export async function POST(request: Request) {
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

    const body = await request.json()
    const { base_url, instance_name, api_key } = body

    if (!base_url || !instance_name || !api_key) {
      return NextResponse.json(
        { error: 'base_url, instance_name and api_key are required' },
        { status: 400 },
      )
    }

    // Verify credentials with Evolution BEFORE saving.
    let statusResult
    try {
      statusResult = await getInstanceStatus({ baseUrl: base_url, apiKey: api_key, instanceName: instance_name })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Evolution error'
      console.error('Evolution verification failed during save:', message)
      return NextResponse.json({ error: `Evolution error: ${message}` }, { status: 400 })
    }

    // Reject if another account already uses this exact (base_url,
    // instance_name) pair. evolution_api_key ciphertext isn't directly
    // comparable (AES-GCM uses a random IV per encryption), so compare
    // on (base_url, instance_name) instead — same identifying pair
    // Evolution itself uses to route requests.
    const { data: candidates, error: candidatesError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('provider', 'evolution')
      .eq('evolution_base_url', base_url)
      .eq('evolution_instance_name', instance_name)
      .neq('account_id', accountId)

    if (candidatesError) {
      console.error('Error checking Evolution instance ownership:', candidatesError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }

    if (candidates && candidates.length > 0) {
      return NextResponse.json(
        {
          error:
            'This Evolution instance is already linked to another account on this instance. Each instance can only be connected to one wacrm account.',
        },
        { status: 409 },
      )
    }

    let encryptedKey: string
    try {
      encryptedKey = encrypt(api_key)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt API key. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 },
      )
    }

    // Switching provider overwrites the single row for this account.
    // Null out the other providers' identity columns so a stale value
    // can't linger (it also frees it up for another account, since
    // several of them are still UNIQUE across the table).
    const baseRow = {
      provider: 'evolution' as const,
      evolution_base_url: base_url,
      evolution_instance_name: instance_name,
      evolution_instance_id: null,
      evolution_api_key: encryptedKey,
      evolution_paired_phone: statusResult.phone ?? null,
      status: statusResult.connected ? 'connected' : 'disconnected',
      connected_at: statusResult.connected ? new Date().toISOString() : null,
      phone_number_id: null,
      waba_id: null,
      access_token: null,
      verify_token: null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
      base_url: null,
      instance_id: null,
      instance_token: null,
      instance_name: null,
      paired_phone: null,
      updated_at: new Date().toISOString(),
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)
      if (updateError) {
        console.error('Error updating whatsapp_config (evolution):', updateError)
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: user.id, ...baseRow })
      if (insertError) {
        console.error('Error inserting whatsapp_config (evolution):', insertError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      saved: true,
      connected: statusResult.connected,
      status: statusResult.status,
    })
  } catch (error) {
    console.error('Error in whatsapp/config/evolution POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config/evolution
 *
 * Removes the authenticated account's WhatsApp configuration row.
 * Mirrors the Meta/uazapi routes' DELETE — same single row, same
 * "Reset" UX.
 */
export async function DELETE() {
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

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config (evolution):', deleteError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in whatsapp/config/evolution DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
