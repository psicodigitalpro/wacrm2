/**
 * Shared inbound-message pipeline — contact/conversation find-or-create,
 * message insert, flow/automation/AI-reply dispatch, and webhook fan-out.
 *
 * Extracted from the Meta webhook route (src/app/api/whatsapp/webhook/route.ts's
 * former `processMessage`) so a second provider's webhook handler
 * (Evolution — src/app/api/whatsapp/webhook/evolution/route.ts) doesn't
 * have to hand-roll a second copy of this ~250-line pipeline. Any
 * provider's webhook route is responsible for translating its own
 * payload shape into a `NormalizedInboundMessage`, then calling
 * `processInboundMessage` — everything after that point is
 * provider-agnostic.
 *
 * uazapi's still-unfinished webhook (currently a diagnostic stub, see
 * src/app/api/whatsapp/webhook/uazapi/route.ts) can adopt this same
 * pipeline once its real payload shape is confirmed.
 */

import { createClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

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

/** The messages.content_type CHECK constraint's allowed values (see
 *  supabase/migrations/001_initial_schema.sql + 010). Any provider's
 *  webhook route must map its own type vocabulary onto this set before
 *  calling processInboundMessage. */
export const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video',
  'location', 'template', 'interactive',
])

export interface NormalizedInboundMessage {
  /** Tenancy — every row created downstream is stamped with this. */
  accountId: string
  /** Sender-of-record for NOT NULL user_id FKs — the admin who saved
   *  the WhatsApp config for this account. */
  configOwnerUserId: string
  senderPhone: string
  contactName: string
  /** The provider's own message id — stored verbatim in messages.message_id
   *  (NOT unique across providers/numbers, same as Meta's ids today). */
  providerMessageId: string
  timestampMs: number
  /** Must already be one of ALLOWED_CONTENT_TYPES. */
  contentType: string
  contentText: string | null
  mediaUrl: string | null
  interactiveReplyId: string | null
  /** Provider message id this message swipe-replies to, if any. */
  replyToProviderMessageId: string | null
  /** When set, short-circuits to a reaction upsert/delete — no message row is inserted. */
  reaction: { targetProviderMessageId: string; emoji: string } | null
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the main
 * inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a provider-side message_id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByProviderId(
  providerMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-pipeline] lookupInternalIdByProviderId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to the provider.
 */
async function handleReaction(
  reaction: { targetProviderMessageId: string; emoji: string },
  conversationId: string,
  contactId: string
) {
  const targetInternalId = await lookupInternalIdByProviderId(
    reaction.targetProviderMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound-pipeline] reaction target message not found; skipping',
      reaction.targetProviderMessageId
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec; Evolution/Baileys
  // follows the same convention).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound-pipeline] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[inbound-pipeline] reaction upsert failed:', upsertError.message)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch below. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Oldest-first, one row — see the Meta webhook's original comment
  // (issue #363) on why `.single()` is intentionally avoided here.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Process one normalized inbound message end-to-end: find-or-create
 * contact + conversation, persist the message (or reaction), and
 * dispatch flows / automations / AI auto-reply / outbound webhooks.
 *
 * Provider-agnostic — callers (Meta's webhook route, Evolution's
 * webhook route) are responsible for everything upstream of this call:
 * signature/auth verification, resolving which account owns the
 * delivery, and translating the provider's payload into a
 * NormalizedInboundMessage.
 */
export async function processInboundMessage(msg: NormalizedInboundMessage): Promise<void> {
  const contactOutcome = await findOrCreateContact(
    msg.accountId,
    msg.configOwnerUserId,
    msg.senderPhone,
    msg.contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    msg.accountId,
    msg.configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened
  // by a reaction still fires the event.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), msg.accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never
  // insert into `messages`, never bump unread_count.
  if (msg.reaction) {
    await handleReaction(msg.reaction, conversation.id, contactRecord.id)
    return
  }

  let replyToInternalId: string | null = null
  if (msg.replyToProviderMessageId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      msg.replyToProviderMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound-pipeline] reply context parent not found:',
        msg.replyToProviderMessageId
      )
    }
  }

  const contentType = ALLOWED_CONTENT_TYPES.has(msg.contentType) ? msg.contentType : 'text'

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: msg.contentText,
    media_url: msg.mediaUrl,
    message_id: msg.providerMessageId,
    status: 'delivered',
    created_at: new Date(msg.timestampMs).toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: msg.interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: msg.contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(msg.accountId, contactRecord.id)

  // Flow runner dispatch — see the original comment block in the Meta
  // webhook route for the full rationale on trigger suppression when a
  // flow consumes the message.
  const flowResult = await dispatchInboundToFlows({
    accountId: msg.accountId,
    userId: msg.configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      msg.interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: msg.interactiveReplyId,
            reply_title: msg.contentText ?? '',
            meta_message_id: msg.providerMessageId,
          }
        : {
            kind: 'text',
            text: msg.contentText ?? '',
            meta_message_id: msg.providerMessageId,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = msg.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (msg.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId: msg.accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: msg.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply — only for plain-text inbound the flow runner did NOT
  // consume, and only when the account has enabled it.
  if (!flowConsumed && !msg.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId: msg.accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId: msg.configOwnerUserId,
    })
  }

  // message.received webhook (public API).
  await dispatchWebhookEvent(supabaseAdmin(), msg.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: msg.providerMessageId,
    content_type: contentType,
    text: msg.contentText,
  })
}
