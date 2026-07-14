import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { computeEvolutionWebhookSecret, getBase64FromMediaMessage } from '@/lib/whatsapp/evolution-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'
import { uploadAccountMediaServer } from '@/lib/storage/upload-media-server'
import {
  processInboundMessage,
  ALLOWED_CONTENT_TYPES,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound-pipeline'

// Same rationale as the Meta webhook route: process after acking so a
// slow downstream call (flows/automations/AI reply) can't cause
// Evolution to retry the delivery and double-insert.
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Inbound webhook for Evolution API instances.
 *
 * The URL is keyed by the whatsapp_config row's own id (set when
 * registering the webhook — see
 * src/app/api/whatsapp/config/evolution/connect/route.ts) rather than
 * resolving the account from the payload's `instance` name, since
 * instance names are chosen per-account on self-hosted servers and
 * aren't guaranteed unique across different accounts' servers.
 *
 * Auth: Evolution doesn't sign deliveries the way Meta does (no HMAC
 * over the raw body). We require a shared secret in the
 * `x-webhook-secret` header instead — set via the `headers` option on
 * POST /webhook/set when the account connects, and verified here
 * against the same HMAC(ENCRYPTION_KEY, configId) derivation. Combined
 * with the URL itself being keyed by an unguessable config UUID, this
 * is comparable in practice to Meta's signature check.
 *
 * Payload shape: Evolution API is a Baileys wrapper and its
 * MESSAGES_UPSERT event follows Baileys' well-documented (if not
 * officially published) shape:
 *   { event, instance, data: { key: { remoteJid, fromMe, id },
 *     pushName, message: { conversation | extendedTextMessage.text |
 *     imageMessage | videoMessage | documentMessage | audioMessage |
 *     reactionMessage }, messageTimestamp }, ... }
 * Text parsing here is high-confidence (this shape is consistent
 * across the Baileys ecosystem). Media parsing — including the
 * `message.base64` sibling field used for inline bytes — is confirmed
 * live (2026-07-14) against real image/audio/sticker deliveries on the
 * crmeltorosa instance. If a payload doesn't match what's expected,
 * this handler logs the raw JSON so the real shape can be read off the
 * logs and the parser adjusted, rather than silently dropping the
 * message.
 */
export async function POST(request: Request, { params }: { params: Promise<{ configId: string }> }) {
  const { configId } = await params

  const providedSecret = request.headers.get('x-webhook-secret')
  let expectedSecret: string
  try {
    expectedSecret = computeEvolutionWebhookSecret(configId)
  } catch (err) {
    console.error('[webhook/evolution] failed to compute expected secret:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!providedSecret || providedSecret !== expectedSecret) {
    console.warn('[webhook/evolution] rejected request with invalid/missing x-webhook-secret', configId)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(await request.text())
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processEvolutionWebhook(configId, body)
    } catch (error) {
      console.error('[webhook/evolution] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processEvolutionWebhook(configId: string, body: Record<string, unknown>) {
  const event = (body.event as string | undefined) ?? ''
  if (!/messages[._]upsert/i.test(event)) {
    // Other subscribed/unsubscribed event types are ignored — we only
    // asked for MESSAGES_UPSERT when registering the webhook, but a
    // manually-edited webhook config on the Evolution side could send
    // more. Not an error.
    return
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select(
      'id, account_id, user_id, provider, evolution_paired_phone, evolution_base_url, evolution_instance_name, evolution_api_key',
    )
    .eq('id', configId)
    .maybeSingle()

  if (configError) {
    console.error('[webhook/evolution] error fetching config:', configError)
    return
  }
  if (!config || config.provider !== 'evolution') {
    console.error('[webhook/evolution] no evolution config found for id:', configId)
    return
  }

  const data = (body.data as Record<string, unknown> | undefined) ?? body
  const normalized = parseEvolutionMessage(data)
  if (!normalized) {
    console.warn(
      '[webhook/evolution] could not parse inbound payload into a message — raw data:',
      JSON.stringify(data),
    )
    return
  }
  if (normalized.fromMe) return // our own outbound message, echoed back — not inbound

  const pushName = (data.pushName as string | undefined) || normalized.senderPhone

  let mediaUrl: string | null = null
  let contentText = normalized.contentText
  if (normalized.mediaInfo) {
    try {
      mediaUrl = await resolveEvolutionMedia(normalized.mediaInfo, normalized.messageId, config)
    } catch (err) {
      // Best-effort — a media download/upload failure must not drop the
      // whole message. Fall through with mediaUrl still null; the inbox
      // renders the "media unavailable" placeholder (same as Meta does
      // when its own media verification fails).
      console.error('[webhook/evolution] media resolution failed:', err)
    }
    if (!mediaUrl && !contentText) {
      contentText = `[${normalized.contentType}]`
    }
  }

  const normalizedMessage: NormalizedInboundMessage = {
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    senderPhone: normalized.senderPhone,
    contactName: pushName,
    providerMessageId: normalized.messageId,
    timestampMs: normalized.timestampMs,
    contentType: normalized.contentType,
    contentText,
    mediaUrl,
    interactiveReplyId: null,
    replyToProviderMessageId: normalized.replyToMessageId,
    reaction: normalized.reaction,
  }
  await processInboundMessage(normalizedMessage)
}

interface EvolutionConfigRow {
  id: string
  account_id: string
  evolution_base_url: string
  evolution_instance_name: string
  evolution_api_key: string
}

/**
 * Download a media message's bytes (inline base64 from the webhook
 * payload, falling back to the getBase64FromMediaMessage REST call when
 * the payload didn't carry one) and upload them to the `chat-media`
 * bucket, returning a public URL — or null if the file exceeds the
 * bucket's size limit.
 */
async function resolveEvolutionMedia(
  mediaInfo: EvolutionMediaInfo,
  messageId: string,
  config: EvolutionConfigRow,
): Promise<string | null> {
  let base64 = mediaInfo.base64Inline
  let mimetype = mediaInfo.mimetype

  if (!base64) {
    const apiKey = decrypt(config.evolution_api_key)
    const result = await getBase64FromMediaMessage({
      baseUrl: config.evolution_base_url,
      apiKey,
      instanceName: config.evolution_instance_name,
      messageId,
    })
    base64 = result.base64
    mimetype = mimetype ?? result.mimetype
    if (!mediaInfo.fileNameHint && result.fileName) {
      mediaInfo.fileNameHint = result.fileName
    }
  }

  const bytes = Buffer.from(base64, 'base64')
  if (bytes.byteLength > MEDIA_MAX_BYTES) {
    console.warn(
      `[webhook/evolution] media for message ${messageId} is ${bytes.byteLength} bytes, over the ${MEDIA_MAX_BYTES}-byte bucket limit — skipping upload.`,
    )
    return null
  }

  const fileName = mediaInfo.fileNameHint ?? `${mediaInfo.kind}.${extFromMimetype(mimetype)}`
  const { publicUrl } = await uploadAccountMediaServer(
    'chat-media',
    config.account_id,
    fileName,
    bytes,
    mimetype ?? 'application/octet-stream',
  )
  return publicUrl
}

/** Best-effort file extension from a MIME type's subtype (e.g. "image/webp" → "webp"). */
function extFromMimetype(mimetype: string | null): string {
  if (!mimetype) return 'bin'
  const subtype = mimetype.split(';')[0].split('/')[1]
  if (!subtype) return 'bin'
  // "audio/ogg" style subtypes are already clean; strip vendor prefixes
  // like "vnd.openxmlformats-officedocument..." down to something short.
  return subtype.replace(/^x-/, '').split('.').pop()!.slice(0, 20)
}

interface EvolutionMediaInfo {
  /** The Baileys message-content kind, e.g. "imageMessage" — used to build a fallback filename. */
  kind: string
  mimetype: string | null
  /** Present only for image/video/document — audio and stickers carry no caption in Baileys. */
  caption: string | null
  /** documentMessage carries a real filename; other kinds don't. */
  fileNameHint: string | null
  /** Inline bytes from the webhook's `base64: true` option, if present. */
  base64Inline: string | null
}

interface ParsedEvolutionMessage {
  senderPhone: string
  messageId: string
  timestampMs: number
  fromMe: boolean
  contentType: string
  contentText: string | null
  mediaUrl: string | null
  replyToMessageId: string | null
  reaction: { targetProviderMessageId: string; emoji: string } | null
  /** Set when this message is a media kind — processEvolutionWebhook resolves it (async) into mediaUrl. */
  mediaInfo: EvolutionMediaInfo | null
}

/**
 * Extract the JID's phone-number portion. Baileys JIDs normally look
 * like "5511999999999@s.whatsapp.net" (individual) or "...@g.us"
 * (group, out of scope here — group inbound isn't handled).
 *
 * WhatsApp's newer "LID" (linked id) addressing can make a JID an
 * opaque id instead of a phone number (`"206051207053553@lid"` — seen
 * via a REST query against a live instance, 2026-07-13). Storing that
 * numeric id as if it were a phone would corrupt the contacts table
 * (wrong/duplicate contacts, no way to actually reach the number), so
 * this only returns a value for `@s.whatsapp.net`/bare-number JIDs and
 * returns null for `@lid` — callers must handle the null case rather
 * than guess.
 */
function phoneFromJid(jid: string): string | null {
  if (jid.endsWith('@lid')) return null
  return jid.split('@')[0]
}

/**
 * Resolve the best available phone-number JID off a message `key`.
 * Confirmed live (2026-07-13): a delivery's `key` can carry both
 * `remoteJid` and `remoteJidAlt` — in the one delivery captured,
 * `remoteJid` was already phone-number form and `remoteJidAlt` matched
 * it exactly, alongside `addressingMode: "lid"`. That pairing strongly
 * suggests `remoteJidAlt` is Baileys/Evolution's phone-number
 * counterpart for the SAME contact when `remoteJid` itself is a `@lid`
 * — but this hasn't been confirmed against an actual `@lid` remoteJid
 * delivery yet, so treat this as the best available inference: prefer
 * whichever of the two is phone-number-shaped, and return null (not a
 * guess) if neither is.
 */
function resolveSenderPhone(key: Record<string, unknown>): string | null {
  const remoteJid = key.remoteJid as string | undefined
  const remoteJidAlt = key.remoteJidAlt as string | undefined
  if (remoteJid) {
    const phone = phoneFromJid(remoteJid)
    if (phone) return phone
  }
  if (remoteJidAlt) {
    const phone = phoneFromJid(remoteJidAlt)
    if (phone) return phone
  }
  return null
}

function parseEvolutionMessage(data: Record<string, unknown>): ParsedEvolutionMessage | null {
  const key = data.key as Record<string, unknown> | undefined
  const messageId = key?.id as string | undefined
  if (!key || !messageId) return null
  const senderPhone = resolveSenderPhone(key)
  if (!senderPhone) {
    console.warn(
      '[webhook/evolution] could not resolve a phone number from this message\'s JID (likely @lid-only) — dropping to avoid storing a bad contact. Raw key:',
      JSON.stringify(key),
    )
    return null
  }

  const fromMe = Boolean(key?.fromMe)
  const timestampRaw = data.messageTimestamp as number | string | undefined
  const timestampMs = timestampRaw
    ? (typeof timestampRaw === 'string' ? parseInt(timestampRaw, 10) : timestampRaw) * 1000
    : Date.now()

  const message = (data.message as Record<string, unknown> | undefined) ?? {}

  // Reactions arrive as a message whose `message.reactionMessage` field
  // is set — same Baileys convention Evolution passes through verbatim.
  const reactionMessage = message.reactionMessage as
    | { key?: { id?: string }; text?: string }
    | undefined
  if (reactionMessage?.key?.id !== undefined) {
    return {
      senderPhone,
      messageId,
      timestampMs,
      fromMe,
      contentType: 'text',
      contentText: null,
      mediaUrl: null,
      replyToMessageId: null,
      reaction: { targetProviderMessageId: reactionMessage.key.id ?? '', emoji: reactionMessage.text ?? '' },
      mediaInfo: null,
    }
  }

  const extendedText = message.extendedTextMessage as
    | { text?: string; contextInfo?: { stanzaId?: string } }
    | undefined
  const replyToMessageId = extendedText?.contextInfo?.stanzaId ?? null

  if (typeof message.conversation === 'string') {
    return {
      senderPhone,
      messageId,
      timestampMs,
      fromMe,
      contentType: 'text',
      contentText: message.conversation,
      mediaUrl: null,
      replyToMessageId,
      reaction: null,
      mediaInfo: null,
    }
  }

  if (extendedText?.text) {
    return {
      senderPhone,
      messageId,
      timestampMs,
      fromMe,
      contentType: 'text',
      contentText: extendedText.text,
      mediaUrl: null,
      replyToMessageId,
      reaction: null,
      mediaInfo: null,
    }
  }

  // Media messages. Per Baileys' WAProto shape: imageMessage/videoMessage/
  // documentMessage carry `caption`; audioMessage (voice notes and regular
  // audio alike — `ptt: true` marks a voice note but both use this same
  // field) and stickerMessage carry none. `message.base64` — a SIBLING of
  // the `*Message` object, not nested inside it — is populated when the
  // webhook was registered with `base64: true` (see setEvolutionWebhook);
  // when absent, processEvolutionWebhook falls back to
  // getBase64FromMediaMessage. Confirmed live (2026-07-14) for all three
  // real deliveries tested — image, audio (ptt voice note), and sticker —
  // byte-exact against each message's fileLength.
  const mediaKinds: Array<[string, string]> = [
    ['imageMessage', 'image'],
    ['videoMessage', 'video'],
    ['documentMessage', 'document'],
    ['audioMessage', 'audio'],
    ['stickerMessage', 'image'],
  ]
  const inlineBase64 = (message.base64 as string | undefined) ?? null
  for (const [field, contentType] of mediaKinds) {
    const media = message[field] as
      | { caption?: string; mimetype?: string; fileName?: string }
      | undefined
    if (media) {
      const resolvedContentType = ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : 'text'
      return {
        senderPhone,
        messageId,
        timestampMs,
        fromMe,
        contentType: resolvedContentType,
        contentText: media.caption ?? null,
        mediaUrl: null,
        replyToMessageId,
        reaction: null,
        mediaInfo: {
          kind: field,
          mimetype: media.mimetype ?? null,
          caption: media.caption ?? null,
          fileNameHint: media.fileName ?? null,
          base64Inline: inlineBase64,
        },
      }
    }
  }

  return null
}
