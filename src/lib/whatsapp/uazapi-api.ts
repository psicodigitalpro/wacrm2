/**
 * uazapi client — an unofficial, QR-code-paired WhatsApp gateway used
 * as an alternative to the Meta WhatsApp Cloud API (see meta-api.ts).
 *
 * Every function takes a single options object (named parameters),
 * matching meta-api.ts's convention — same rationale: named params
 * turn a swapped-argument bug into a compile-time TypeScript error
 * instead of a runtime rejection.
 *
 * Auth: uazapi authenticates with a per-instance `token` header (NOT
 * `Authorization: Bearer`, unlike Meta) — confirmed via uazapi's public
 * docs/community sources and by a live GET /instance/status call.
 *
 * GET /instance/status was confirmed against a live instance (2026-07-13):
 * `{ instance: { id, status, paircode, qrcode, owner, ... }, status: { connected, jid, loggedIn, resetting } }`.
 * getInstanceStatus's parsing below matches that shape exactly.
 *
 * POST /instance/connect has NOT been exercised against a live instance
 * (calling it on an already-paired session risks forcing a re-pair/
 * disconnect of a real number), so parseConnectResponse stays tolerant
 * of a couple of plausible field-name variants beyond the ones confirmed
 * via /instance/status, and throws a clear, raw-body-including error if
 * none match — so the first real connect surfaces exactly what to adjust.
 */

export interface UazapiSendResult {
  messageId: string
}

interface UazapiErrorResponse {
  error?: string
  message?: string
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorResponse
    if (data.message) message = data.message
    else if (data.error) message = data.error
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

function uazapiHeaders(instanceToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    token: instanceToken,
  }
}

// ============================================================
// Connect / pairing
// ============================================================

export interface ConnectInstanceArgs {
  baseUrl: string
  instanceToken: string
  /** Shown as the linked device's name in WhatsApp's "Linked Devices" list. */
  systemName?: string
  browser?: string
  proxy_managed_country?: string
  proxy_managed_state?: string
  proxy_managed_city?: string
}

export interface ConnectInstanceResult {
  /** Base64 (often a data: URL) QR image to scan, when uazapi returns one. */
  qrCode: string | null
  /** Numeric pairing code, when uazapi returns one instead of/alongside a QR. */
  pairingCode: string | null
  status: string
  /** uazapi's instance id (`instance.id`) — persisted as whatsapp_config.instance_id. */
  instanceId: string | null
}

/**
 * Start (or resume) pairing for a uazapi instance. The caller displays
 * `qrCode`/`pairingCode` in Settings and polls `getInstanceStatus` until
 * `status` reads as connected.
 */
export async function connectInstance(
  args: ConnectInstanceArgs
): Promise<ConnectInstanceResult> {
  const { baseUrl, instanceToken, systemName, browser, ...proxyFields } = args
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/instance/connect`, {
    method: 'POST',
    headers: uazapiHeaders(instanceToken),
    body: JSON.stringify({
      browser: browser ?? 'auto',
      systemName,
      ...proxyFields,
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi connect failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  return parseConnectResponse(data)
}

/**
 * Confirmed against a live instance (GET /instance/status, which returns
 * the same `instance` object /instance/connect is expected to): fields
 * are `instance.qrcode`, `instance.paircode`, `instance.status`,
 * `instance.id`, `instance.owner`. /instance/connect itself hasn't been
 * exercised against a live instance yet (calling it on an already-paired
 * session risks forcing a re-pair), so this stays tolerant of a couple
 * of extra plausible variants rather than locking down to exactly one.
 */
function parseConnectResponse(data: Record<string, unknown>): ConnectInstanceResult {
  const root = (data.instance as Record<string, unknown> | undefined) ?? data
  const qrCode =
    (root.qrcode as string | undefined) ??
    (root.qr_code as string | undefined) ??
    (root.base64 as string | undefined) ??
    null
  const pairingCode =
    (root.paircode as string | undefined) ??
    (root.pairingCode as string | undefined) ??
    (root.pairing_code as string | undefined) ??
    null
  const status = (root.status as string | undefined) ?? 'unknown'
  const instanceId = (root.id as string | undefined) ?? null
  if (!qrCode && !pairingCode) {
    throw new Error(
      `uazapi connect response had neither a QR code nor a pairing code — raw response: ${JSON.stringify(data)}`
    )
  }
  return { qrCode, pairingCode, status, instanceId }
}

// ============================================================
// Status
// ============================================================

export interface InstanceStatusArgs {
  baseUrl: string
  instanceToken: string
}

export interface InstanceStatusResult {
  /** Raw status string from uazapi (e.g. 'connected' / 'disconnected' / 'connecting'). */
  status: string
  connected: boolean
  /** The paired WhatsApp number, once connected. */
  phone: string | null
  /** uazapi's instance id (`instance.id`) — persisted as whatsapp_config.instance_id. */
  instanceId: string | null
}

/**
 * Confirmed against a live instance: the response is
 * `{ instance: { id, status, paircode, qrcode, owner, ... }, status: { connected, jid, loggedIn, resetting } }`
 * — note the top-level `status` is a SIBLING of `instance`, not nested
 * inside it, and carries the authoritative `connected` boolean (the
 * `instance.status` string was observed to mirror it, but the boolean
 * is the one to trust). The paired phone number is `instance.owner`,
 * not `instance.phone`.
 */
export async function getInstanceStatus(
  args: InstanceStatusArgs
): Promise<InstanceStatusResult> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/instance/status`, {
    headers: uazapiHeaders(instanceToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi status check failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  const instance = (data.instance as Record<string, unknown> | undefined) ?? data
  const statusObj = data.status as Record<string, unknown> | undefined
  const status = (instance.status as string | undefined) ?? 'unknown'
  const phone =
    (instance.owner as string | undefined) ?? (instance.phone as string | undefined) ?? null
  const instanceId = (instance.id as string | undefined) ?? null
  const connected =
    typeof statusObj?.connected === 'boolean'
      ? statusObj.connected
      : /connect/i.test(status) && !/disconnect/i.test(status)
  return { status, connected, phone, instanceId }
}

// ============================================================
// Sending
// ============================================================

export interface SendUazapiTextArgs {
  baseUrl: string
  instanceToken: string
  /** Recipient's phone number, digits only (see phone-utils.ts). */
  number: string
  text: string
}

export async function sendUazapiText(args: SendUazapiTextArgs): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, number, text } = args
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/send/text`, {
    method: 'POST',
    headers: uazapiHeaders(instanceToken),
    body: JSON.stringify({ number, text }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi send/text failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  return { messageId: extractMessageId(data) }
}

export type UazapiMediaKind = 'image' | 'video' | 'audio' | 'document'

export interface SendUazapiMediaArgs {
  baseUrl: string
  instanceToken: string
  number: string
  type: UazapiMediaKind
  /** Public URL uazapi fetches at send time. */
  file: string
  caption?: string
}

export async function sendUazapiMedia(args: SendUazapiMediaArgs): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, number, type, file, caption } = args
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/send/media`, {
    method: 'POST',
    headers: uazapiHeaders(instanceToken),
    body: JSON.stringify({ number, type, file, ...(caption ? { caption } : {}) }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi send/media failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  return { messageId: extractMessageId(data) }
}

/**
 * Tolerant of a few plausible id field names — same reasoning as
 * `parseConnectResponse`. Falls back to an empty string (rather than
 * throwing) so a send that otherwise succeeded doesn't get reported as
 * failed just because the id couldn't be located; callers persist
 * whatever comes back.
 */
function extractMessageId(data: Record<string, unknown>): string {
  const root = (data.key as Record<string, unknown> | undefined) ?? data
  return (
    (root.id as string | undefined) ??
    (root.messageId as string | undefined) ??
    (root.message_id as string | undefined) ??
    ''
  )
}
