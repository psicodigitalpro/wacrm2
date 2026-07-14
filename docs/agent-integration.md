# Integrating an external agent (qualify / schedule / remind)

A common pattern is to run the actual conversational agent — the part
that qualifies a lead, checks a calendar, books an appointment, and
sends reminders — **outside** wacrm, in a tool built for that (n8n,
Make, a custom service, etc.), and use wacrm as the system of record
for contacts, tags, and conversation history that a human team can see.
This page covers what's already there for that (the [public
API](./public-api.md)) and what it can't do yet, so you don't build
against the wrong assumption.

> **Status:** this describes today's capabilities, not a dedicated
> "agent" feature — there is no agent-specific endpoint or SDK. It's a
> composition of the same public API described in
> [public-api.md](./public-api.md).

## What wacrm can do for an external agent today

- **Tag a lead as it's qualified.** `PATCH /api/v1/contacts/{id}` (or
  `POST /api/v1/contacts` to find-or-create by phone first) with a
  `tags` array — e.g. `["lead-qualificado"]`, then `["lead-quente"]`
  once your agent's logic decides it's hot. Scope: `contacts:write`.
- **Read/send messages in a conversation**, so a human agent looking at
  the wacrm inbox sees the same thread your external agent is running —
  `GET /api/v1/conversations/{id}/messages` (`messages:read`),
  `POST /api/v1/messages` (`messages:send`) if you also want wacrm to
  send on the agent's behalf instead of the agent's own WhatsApp
  gateway call.
- **Get notified of inbound messages** without polling — subscribe to
  `message.received` via `POST /api/v1/webhooks` (`webhooks:manage`).
  Useful if wacrm is the one connected to WhatsApp and your agent needs
  to react to what arrives.

See [public-api.md](./public-api.md) for auth, scopes, and the full
endpoint list — this page only calls out the pieces relevant to an
agent integration.

## What it can't do (yet)

- **No appointment/calendar model.** There's no booking, slot, or
  appointment concept anywhere in wacrm — no endpoint to create, move,
  or cancel one. Scheduling has to happen in whatever calendar system
  your agent already uses (Google Calendar, etc.); wacrm only finds out
  about the *outcome* (e.g. via a tag or a logged message), not the
  appointment itself.
- **No deals/pipeline write API.** The dashboard has pipelines and
  deals, but `/api/v1` doesn't expose them yet (tracked as a future
  idea in the [public API roadmap](./public-api.md#roadmap)). An agent
  can't move a contact through a sales stage via the API today.
- **No reminder/scheduling primitive in the API.** wacrm's own
  Automations feature has a `wait` step for in-app delayed sends, but
  that's not reachable externally — a reminder your agent needs to send
  has to be scheduled on the agent's side (a cron, a queue, whatever it
  already uses for that).

## One WhatsApp number, one webhook

A WhatsApp gateway (Meta Cloud API, Evolution, uazapi) delivers inbound
messages to **exactly one webhook URL per number/instance** — there's
no fan-out. That means a given number either feeds wacrm's own inbox
*or* your external agent directly; not both, without one relaying to
the other. Two ways to combine them:

1. **Agent-owned number, relay into wacrm.** Your agent's WhatsApp
   gateway webhook points at the agent. After the agent processes a
   message (and especially when it hands off to a human), it calls
   wacrm's API to create/tag the contact and log what happened, so the
   conversation is visible in the wacrm inbox too.
2. **wacrm-owned number, relay out to the agent.** wacrm's own webhook
   (Settings → WhatsApp) receives the message; a wacrm outbound webhook
   subscription (`message.received`) notifies your agent, which does
   its qualify/schedule/remind logic and calls back into wacrm
   (`POST /api/v1/messages`) to actually send the reply.

Pick whichever system should own the WhatsApp connection — usually
whichever one is doing more of the real-time work (the agent, if it's
driving most of the conversation).

## Minimal example: tag a lead as qualified

```bash
curl -X PATCH https://your-crm.example.com/api/v1/contacts/<contact_id> \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "tags": ["lead-qualificado", "lead-quente"] }'
```

Create the API key in **Settings → API keys**, scoped to only what the
integration needs (`contacts:write` for the example above; add
`messages:read` / `messages:send` / `webhooks:manage` per the
capabilities you actually use). See
[Creating a key](./public-api.md#creating-a-key).
