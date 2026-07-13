import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { sendUazapiText } from '@/lib/whatsapp/uazapi-api'
import { renderTemplateBodyText } from '@/lib/whatsapp/template-render-text'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { loadWhatsAppConfig, type ResolvedWhatsAppConfig } from '@/lib/whatsapp/provider-config'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { supabaseAdmin } from './admin-client'

/** Phone-variant retry is a Meta sandbox workaround only — uazapi has
 *  no allow-list, so it only ever gets the one sanitized number. */
function variantsForProvider(config: ResolvedWhatsAppConfig, sanitized: string): string[] {
  return config.provider === 'uazapi' ? [sanitized] : phoneVariants(sanitized)
}

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const config = await loadWhatsAppConfig(db, input.accountId)
  if (!config) {
    throw new Error('WhatsApp not configured for this account')
  }

  // uazapi has no template-approval system — a "template" send there
  // just means sending the template's rendered body as free-form text.
  // Resolve it once, up front, so `attempt` doesn't re-fetch per retry.
  let uazapiRenderedText: string | null = null
  if (config.provider === 'uazapi' && input.kind === 'template') {
    const { data: templateRow, error: templateErr } = await db
      .from('message_templates')
      .select('body_text')
      .eq('account_id', input.accountId)
      .eq('name', input.templateName)
      .eq('language', input.language || 'en_US')
      .maybeSingle()
    if (templateErr || !templateRow?.body_text) {
      throw new Error(`Template "${input.templateName}" not found locally for uazapi fallback`)
    }
    uazapiRenderedText = renderTemplateBodyText(templateRow.body_text, input.params)
  }

  const attempt = async (phone: string): Promise<string> => {
    if (config.provider === 'uazapi') {
      const r = await sendUazapiText({
        baseUrl: config.baseUrl!,
        instanceToken: config.instanceToken!,
        number: phone,
        text: input.kind === 'template' ? uazapiRenderedText! : input.text,
      })
      return r.messageId
    }
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phoneNumberId!,
        accessToken: config.accessToken!,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phoneNumberId!,
      accessToken: config.accessToken!,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message. uazapi has no such allow-list.
  const variants = variantsForProvider(config, sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the sent message so it appears in the inbox with a real
  // message id. sender_type='bot' distinguishes automation sends from
  // manual agent sends. A uazapi template fallback was actually sent
  // as plain text, so it's persisted as content_type='text' with the
  // rendered body — not as an unfulfillable 'template' row.
  const isUazapiTemplateFallback = config.provider === 'uazapi' && input.kind === 'template'
  const content_type = input.kind === 'template' && !isUazapiTemplateFallback ? 'template' : 'text'
  const content_text = isUazapiTemplateFallback
    ? uazapiRenderedText
    : input.kind === 'text'
      ? input.text
      : null
  const template_name = input.kind === 'template' && !isUazapiTemplateFallback ? input.templateName : null

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template' && !isUazapiTemplateFallback
          ? `[template:${input.templateName}]`
          : content_text!,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
