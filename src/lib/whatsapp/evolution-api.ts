/**
 * Evolution API client — an unofficial, Baileys-based, self-hostable
 * WhatsApp gateway used as a third provider alongside the Meta Cloud
 * API (meta-api.ts) and uazapi (uazapi-api.ts).
 *
 * Every function takes a single options object (named parameters),
 * matching meta-api.ts/uazapi-api.ts's convention — same rationale:
 * named params turn a swapped-argument bug into a compile-time
 * TypeScript error instead of a runtime rejection.
 *
 * Auth: Evolution API v2 authenticates with an `apikey` header. We use
 * the PER-INSTANCE key (the `hash` returned by POST /instance/create),
 * not the server's global admin key — storing the global key per
 * account would let a single compromised row control every instance on
 * the account's Evolution server. See migration 038 for the rationale.
 *
 * Endpoints confirmed against the official docs
 * (docs.evolutionfoundation.com.br, 2026-07-13) for v2.3.7:
 *   POST /instance/create                     — create + get pairing hash
 *   GET  /instance/connect/{instanceName}      — (re)start pairing, get QR
 *   POST /message/sendText/{instanceName}      — send text
 *   POST /webhook/set/{instanceName}           — register inbound webhook
 *
 * NOT confirmed against a live instance yet (docs didn't publish exact
 * response field names for these): the connection-status endpoint and
 * the media-send endpoint. Both are implemented with tolerant parsing
 * (same pattern as uazapi-api.ts's parseConnectResponse) and should be
 * verified against https://evo.eltonrosa.site before relying on them.
 */

import crypto from 'crypto'

export interface EvolutionSendResult {
  messageId: string
}

interface EvolutionErrorResponse {
  error?: string
  message?: string | string[]
  response?: { message?: string | string[] }
}

async function throwEvolutionError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as EvolutionErrorResponse
    const raw = data.response?.message ?? data.message ?? data.error
    if (Array.isArray(raw)) message = raw.join('; ')
    else if (raw) message = raw
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

function evolutionHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    apikey: apiKey,
  }
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

// ============================================================
// Instance creation
// ============================================================

export interface CreateInstanceArgs {
  baseUrl: string
  /** The server's global admin apikey — only needed for this one call. */
  globalApiKey: string
  instanceName: string
  webhookUrl?: string
}

export interface CreateInstanceResult {
  /** Per-instance apikey — persisted encrypted as whatsapp_config.evolution_api_key. */
  apiKey: string
  instanceId: string | null
  qrCode: string | null
  pairingCode: string | null
  status: string
}

/**
 * Confirmed against the official docs: POST /instance/create returns
 * `{ instance: { instanceName, instanceId, integration, status }, hash,
 * qrcode: { code, base64, count }, settings }`. `hash` is the
 * per-instance apikey to use for every subsequent call for this
 * instance (connect/status/send/webhook).
 */
export async function createInstance(args: CreateInstanceArgs): Promise<CreateInstanceResult> {
  const { baseUrl, globalApiKey, instanceName, webhookUrl } = args
  const response = await fetch(`${trimBaseUrl(baseUrl)}/instance/create`, {
    method: 'POST',
    headers: evolutionHeaders(globalApiKey),
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      ...(webhookUrl
        ? { webhook: { enabled: true, url: webhookUrl, events: ['MESSAGES_UPSERT'] } }
        : {}),
    }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution instance/create failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  return parseCreateResponse(data)
}

function parseCreateResponse(data: Record<string, unknown>): CreateInstanceResult {
  const instance = (data.instance as Record<string, unknown> | undefined) ?? {}
  const qrcode = (data.qrcode as Record<string, unknown> | undefined) ?? {}
  const apiKey = (data.hash as string | undefined) ?? ''
  if (!apiKey) {
    throw new Error(
      `Evolution instance/create response had no "hash" (per-instance apikey) — raw response: ${JSON.stringify(data)}`,
    )
  }
  return {
    apiKey,
    instanceId: (instance.instanceId as string | undefined) ?? null,
    qrCode: (qrcode.base64 as string | undefined) ?? null,
    pairingCode: (qrcode.code as string | undefined) ?? null,
    status: (instance.status as string | undefined) ?? 'unknown',
  }
}

// ============================================================
// Connect / pairing
// ============================================================

export interface ConnectInstanceArgs {
  baseUrl: string
  apiKey: string
  instanceName: string
}

export interface ConnectInstanceResult {
  qrCode: string | null
  pairingCode: string | null
  status: string
}

/**
 * Confirmed against the official docs: GET /instance/connect/{instanceName}
 * returns `{ pairingCode, code, base64, count }` — `base64` is a
 * `data:image/png;base64,...` QR image, `code` is the raw connection
 * code (not the numeric pairing code — that's `pairingCode`, nullable).
 */
export async function connectInstance(args: ConnectInstanceArgs): Promise<ConnectInstanceResult> {
  const { baseUrl, apiKey, instanceName } = args
  const response = await fetch(
    `${trimBaseUrl(baseUrl)}/instance/connect/${encodeURIComponent(instanceName)}`,
    { headers: evolutionHeaders(apiKey) },
  )
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution instance/connect failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  return {
    qrCode: (data.base64 as string | undefined) ?? null,
    pairingCode: (data.pairingCode as string | undefined) ?? null,
    status: 'connecting',
  }
}

// ============================================================
// Status
// ============================================================

export interface InstanceStatusArgs {
  baseUrl: string
  apiKey: string
  instanceName: string
}

export interface InstanceStatusResult {
  status: string
  connected: boolean
  phone: string | null
}

/**
 * Confirmed against a live instance (2026-07-13, evo.eltonrosa.site):
 * `GET /instance/connectionState/{instanceName}` only returns
 * `{ instance: { instanceName, state } }` — no paired-phone field at
 * all. `GET /instance/fetchInstances?instanceName={instanceName}`
 * returns a richer array (one element) with `connectionStatus` (same
 * concept as `state`, different key name) AND `ownerJid` — the paired
 * number as a JID (e.g. "554896452217@s.whatsapp.net"), NOT a bare
 * `owner`/`number` field as originally guessed from the docs. Using
 * fetchInstances here so one call gets both status and phone.
 */
export async function getInstanceStatus(args: InstanceStatusArgs): Promise<InstanceStatusResult> {
  const { baseUrl, apiKey, instanceName } = args
  const response = await fetch(
    `${trimBaseUrl(baseUrl)}/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`,
    { headers: evolutionHeaders(apiKey) },
  )
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution fetchInstances check failed: ${response.status}`)
  }
  const data = (await response.json()) as unknown
  const list = Array.isArray(data) ? data : [data]
  const instance = (list[0] as Record<string, unknown> | undefined) ?? {}
  const rawStatus =
    (instance.connectionStatus as string | undefined) ?? (instance.state as string | undefined) ?? 'unknown'
  const connected = /open|connected/i.test(rawStatus)
  const ownerJid = instance.ownerJid as string | undefined
  const phone = ownerJid ? ownerJid.split('@')[0] : (instance.number as string | undefined) ?? null
  return { status: rawStatus, connected, phone }
}

// ============================================================
// Sending
// ============================================================

export interface SendEvolutionTextArgs {
  baseUrl: string
  apiKey: string
  instanceName: string
  /** Recipient's phone number, digits only (see phone-utils.ts). */
  number: string
  text: string
}

/**
 * Confirmed against a live instance (2026-07-13, evo.eltonrosa.site,
 * v2.3.7): the official docs said the body nests under `textMessage`,
 * but that shape 400s with "instance requires property \"text\"" — the
 * real body is FLAT, `{ number, text }`, same convention as uazapi.
 * Response on success (201): `{ key: { remoteJid, fromMe, id },
 * pushName, status, message: { conversation }, messageType,
 * messageTimestamp, instanceId, source }` — message id is `key.id`,
 * already what `extractMessageId` reads first.
 */
export async function sendEvolutionText(args: SendEvolutionTextArgs): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, number, text } = args
  const response = await fetch(
    `${trimBaseUrl(baseUrl)}/message/sendText/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      headers: evolutionHeaders(apiKey),
      body: JSON.stringify({ number, text }),
    },
  )
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution sendText failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  return { messageId: extractMessageId(data) }
}

export type EvolutionMediaKind = 'image' | 'video' | 'audio' | 'document'

export interface SendEvolutionMediaArgs {
  baseUrl: string
  apiKey: string
  instanceName: string
  number: string
  type: EvolutionMediaKind
  /** Public URL Evolution fetches at send time. */
  media: string
  caption?: string
}

/**
 * Confirmed live (2026-07-14) against the crmeltorosa instance — the
 * flat body `{number, mediatype, media, caption}` was accepted and
 * delivered a real image with caption, same flat-body convention as
 * sendEvolutionText (the official docs show a nested `mediaMessage`
 * wrapper, which is wrong, same as it was for sendText).
 */
export async function sendEvolutionMedia(args: SendEvolutionMediaArgs): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, number, type, media, caption } = args
  const response = await fetch(
    `${trimBaseUrl(baseUrl)}/message/sendMedia/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      headers: evolutionHeaders(apiKey),
      body: JSON.stringify({ number, mediatype: type, media, ...(caption ? { caption } : {}) }),
    },
  )
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution sendMedia failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  return { messageId: extractMessageId(data) }
}

/**
 * Tolerant of a few plausible id field names — same reasoning as
 * uazapi-api.ts's extractMessageId. Falls back to an empty string
 * (rather than throwing) so a send that otherwise succeeded doesn't get
 * reported as failed just because the id couldn't be located.
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

// ============================================================
// Media download
// ============================================================

export interface GetBase64FromMediaMessageArgs {
  baseUrl: string
  apiKey: string
  instanceName: string
  /** The provider message id (key.id) of the media message. */
  messageId: string
  /** Transcode video to mp4 server-side. Defaults to true — matches the documented example. */
  convertToMp4?: boolean
}

export interface GetBase64FromMediaMessageResult {
  base64: string
  mimetype: string | null
  fileName: string | null
}

/**
 * Confirmed real via the official docs (docs.evolutionfoundation.com.br,
 * "Get Base64" page under chat-controller) and corroborated by
 * community issue reports: POST /chat/getBase64FromMediaMessage/{instanceName}
 * with body `{ message: { key: { id } }, convertToMp4 }` returns the
 * media's bytes as base64. Used as a FALLBACK when a webhook delivery's
 * inline `message.base64` field (set via the `base64: true` webhook
 * option — see setEvolutionWebhook) is missing, and as the mechanism to
 * confirm the inline-base64 assumption live in the first place. Exact
 * response field names not independently verified against v2.3.7 — kept
 * tolerant of a couple of plausible shapes.
 */
export async function getBase64FromMediaMessage(
  args: GetBase64FromMediaMessageArgs,
): Promise<GetBase64FromMediaMessageResult> {
  const { baseUrl, apiKey, instanceName, messageId, convertToMp4 = true } = args
  const response = await fetch(
    `${trimBaseUrl(baseUrl)}/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      headers: evolutionHeaders(apiKey),
      body: JSON.stringify({ message: { key: { id: messageId } }, convertToMp4 }),
    },
  )
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution getBase64FromMediaMessage failed: ${response.status}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  const base64 = (data.base64 as string | undefined) ?? ''
  if (!base64) {
    throw new Error(
      `Evolution getBase64FromMediaMessage response had no "base64" field — raw response keys: ${Object.keys(data).join(', ')}`,
    )
  }
  return {
    base64,
    mimetype: (data.mimetype as string | undefined) ?? null,
    fileName: (data.fileName as string | undefined) ?? null,
  }
}

// ============================================================
// Webhook registration
// ============================================================

export interface SetWebhookArgs {
  baseUrl: string
  apiKey: string
  instanceName: string
  url: string
  /** Extra headers Evolution echoes back on every webhook delivery — used to carry the shared secret below. */
  webhookHeaders?: Record<string, string>
}

/**
 * Confirmed against a live instance (2026-07-13, evo.eltonrosa.site,
 * v2.3.7): the official docs showed a flat body, but that 400s with
 * "instance requires property \"webhook\"" — the real body wraps
 * everything under a `webhook` key: `{ webhook: { enabled, url,
 * events, headers?, base64? } }`. Subscribing only to MESSAGES_UPSERT
 * for now (inbound message delivery) — extend `events` if other event
 * types are needed later.
 */
export async function setEvolutionWebhook(args: SetWebhookArgs): Promise<void> {
  const { baseUrl, apiKey, instanceName, url, webhookHeaders } = args
  const response = await fetch(
    `${trimBaseUrl(baseUrl)}/webhook/set/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      headers: evolutionHeaders(apiKey),
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url,
          events: ['MESSAGES_UPSERT'],
          base64: true,
          ...(webhookHeaders ? { headers: webhookHeaders } : {}),
        },
      }),
    },
  )
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution webhook/set failed: ${response.status}`)
  }
}

// ============================================================
// Webhook delivery authentication
// ============================================================

/**
 * Evolution API doesn't sign webhook deliveries the way Meta does
 * (HMAC over the raw body via x-hub-signature-256) — its `headers`
 * option on /webhook/set just echoes back whatever static headers we
 * ask for. We use that to carry a per-config shared secret, derived
 * deterministically from ENCRYPTION_KEY + the config id (no new DB
 * column needed), and require it on every inbound delivery. Combined
 * with the webhook URL itself being keyed by an unguessable config
 * UUID, this gives inbound Evolution deliveries a similar assurance
 * level to Meta's signature check.
 */
export function computeEvolutionWebhookSecret(configId: string): string {
  const key = process.env.ENCRYPTION_KEY
  if (!key) throw new Error('ENCRYPTION_KEY is not configured')
  return crypto.createHmac('sha256', key).update(configId).digest('hex')
}
