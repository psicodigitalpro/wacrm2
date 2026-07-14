import { createClient } from '@supabase/supabase-js'
import { buildMediaPath } from './upload-media'

/**
 * Server-side counterpart to `uploadAccountMedia` (upload-media.ts).
 * That helper uses the browser Supabase client and a signed-in user's
 * session — there's no session inside a webhook route, so this uses the
 * service-role client instead (bypasses Storage RLS entirely, which is
 * fine here since the caller — the inbound webhook pipeline — has
 * already resolved `accountId` from a trusted source, the matched
 * `whatsapp_config` row, not user input).
 *
 * Reuses `buildMediaPath` so both upload paths land under the exact
 * same `<bucket>/account-<id>/<timestamp>-<name>.<ext>` convention.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

export interface UploadAccountMediaServerResult {
  publicUrl: string
  path: string
}

/**
 * Upload a Buffer to an account-scoped Storage bucket from server code
 * (webhook routes, background jobs). Throws on failure — callers decide
 * whether that's fatal to the surrounding operation (the Evolution
 * inbound pipeline treats an upload failure as "no media", not a
 * dropped message — see webhook/evolution/[configId]/route.ts).
 */
export async function uploadAccountMediaServer(
  bucket: string,
  accountId: string,
  fileName: string,
  bytes: Buffer,
  contentType: string,
): Promise<UploadAccountMediaServerResult> {
  const path = buildMediaPath(accountId, fileName)
  const { error: upErr } = await supabaseAdmin()
    .storage.from(bucket)
    .upload(path, bytes, {
      cacheControl: '3600',
      upsert: false,
      contentType,
    })
  if (upErr) throw new Error(upErr.message)

  const {
    data: { publicUrl },
  } = supabaseAdmin().storage.from(bucket).getPublicUrl(path)

  return { publicUrl, path }
}
