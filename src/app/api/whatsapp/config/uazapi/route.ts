import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile. Mirrors the
 * helper in ../route.ts (Meta's config route) — kept duplicated rather
 * than shared since both are small and the two routes are otherwise
 * independent (see the uazapi provider plan for why Meta's route is
 * left untouched).
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
 * GET /api/whatsapp/config/uazapi
 *
 * Health check for the uazapi connection, used the same way the Meta
 * route's GET is used by "Test Connection". Returns 200 in every
 * non-auth case so the UI can render a message instead of a 500.
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
      .select('provider, base_url, instance_token, paired_phone')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 },
      )
    }

    if (!config || config.provider !== 'uazapi') {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No uazapi configuration saved yet.',
        },
        { status: 200 },
      )
    }

    let instanceToken: string
    try {
      instanceToken = decrypt(config.instance_token)
    } catch (err) {
      console.error('[whatsapp/config/uazapi GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored instance token cannot be decrypted with the current ENCRYPTION_KEY. Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 },
      )
    }

    try {
      const status = await getInstanceStatus({ baseUrl: config.base_url, instanceToken })
      return NextResponse.json({
        connected: status.connected,
        status: status.status,
        phone: status.phone ?? config.paired_phone ?? null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown uazapi error'
      console.error('[whatsapp/config/uazapi GET] status check failed:', message)
      return NextResponse.json(
        { connected: false, reason: 'uazapi_api_error', message: `uazapi rejected the request: ${message}` },
        { status: 200 },
      )
    }
  } catch (error) {
    console.error('Error in whatsapp/config/uazapi GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/whatsapp/config/uazapi
 *
 * Saves the account's uazapi connection (base_url + instance_token).
 * Verifies the credentials against uazapi first, then encrypts and
 * stores. Switching an account from Meta to uazapi (or vice versa) is
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
    const { base_url, instance_token, instance_name } = body

    if (!base_url || !instance_token) {
      return NextResponse.json(
        { error: 'base_url and instance_token are required' },
        { status: 400 },
      )
    }

    // Verify credentials with uazapi BEFORE saving.
    let statusResult
    try {
      statusResult = await getInstanceStatus({ baseUrl: base_url, instanceToken: instance_token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown uazapi error'
      console.error('uazapi verification failed during save:', message)
      return NextResponse.json({ error: `uazapi error: ${message}` }, { status: 400 })
    }

    // Reject if another account already uses this exact (base_url,
    // instance_token) pair. instance_token ciphertext isn't directly
    // comparable (AES-GCM uses a random IV per encryption), so decrypt
    // each candidate row and compare in JS — same approach the Meta
    // webhook's verify_token lookup uses (see api/whatsapp/webhook/route.ts).
    const { data: candidates, error: candidatesError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id, instance_token')
      .eq('provider', 'uazapi')
      .eq('base_url', base_url)
      .neq('account_id', accountId)

    if (candidatesError) {
      console.error('Error checking uazapi instance ownership:', candidatesError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }

    for (const candidate of candidates ?? []) {
      try {
        if (decrypt(candidate.instance_token) === instance_token) {
          return NextResponse.json(
            {
              error:
                'This uazapi instance is already linked to another account on this instance. Each instance can only be connected to one wacrm account.',
            },
            { status: 409 },
          )
        }
      } catch {
        // Undecryptable row (stale ENCRYPTION_KEY) — skip, not a match.
      }
    }

    let encryptedToken: string
    try {
      encryptedToken = encrypt(instance_token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 },
      )
    }

    // Switching provider overwrites the single row for this account.
    // Null out the other provider's identity columns so a stale
    // phone_number_id can't linger (it also frees that value up for
    // another account, since it's still UNIQUE across the table).
    if (!statusResult.instanceId) {
      console.error('[whatsapp/config/uazapi POST] uazapi status response had no instance id')
      return NextResponse.json(
        { error: 'uazapi did not return an instance id for this token.' },
        { status: 502 },
      )
    }

    const baseRow = {
      provider: 'uazapi' as const,
      base_url,
      instance_id: statusResult.instanceId,
      instance_token: encryptedToken,
      instance_name: instance_name || null,
      paired_phone: statusResult.phone ?? null,
      status: statusResult.connected ? 'connected' : 'disconnected',
      connected_at: statusResult.connected ? new Date().toISOString() : null,
      phone_number_id: null,
      waba_id: null,
      access_token: null,
      verify_token: null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
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
        console.error('Error updating whatsapp_config (uazapi):', updateError)
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: user.id, ...baseRow })
      if (insertError) {
        console.error('Error inserting whatsapp_config (uazapi):', insertError)
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
    console.error('Error in whatsapp/config/uazapi POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config/uazapi
 *
 * Removes the authenticated account's WhatsApp configuration row.
 * Mirrors the Meta route's DELETE — same single row, same "Reset" UX.
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
      console.error('Error deleting whatsapp_config (uazapi):', deleteError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in whatsapp/config/uazapi DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
