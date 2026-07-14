# wacrm

@AGENTS.md

## Commands

```bash
npm run dev          # dev server (port 3000, or next free port)
npm run build         # production build
npm run typecheck     # tsc --noEmit
npm run lint           # eslint
npm run test            # vitest run (5 pre-existing failures in currency.test.ts /
                         # date-utils.test.ts are locale/timezone-dependent, unrelated
                         # to most changes — don't chase them)
npm run format         # prettier --write .
```

Always run `typecheck` after any change; run `test` before considering a change done.

## Deploy — READ THIS BEFORE PUSHING ANYTHING PRODUCTION-RELATED

**This repo's `origin` remote is NOT what production deploys from.** The live site
(`crmeltonrosa.com`, hosted on Hostinger hPanel) is connected to a *different*
GitHub repository: `ecosmart-collab/wacrm` (shown in Hostinger's panel just as
"wacrm"). Hostinger auto-deploys on push to that repo's `main`. Pushing to this
repo's `origin` (`psicodigitalpro/wacrm2`) does **not** reach production by itself.

The two repos diverged a while back — `ecosmart-collab/wacrm` is missing large
chunks of history (the uazapi provider, duplicate-conversation fixes, etc.), so
don't try to merge them wholesale. After committing here, port just the new
commit(s) over:

```bash
git remote add ecosmart https://github.com/ecosmart-collab/wacrm.git
git fetch ecosmart main
git log ecosmart/main --oneline -5      # see what's already there first
git branch -f tmp-port ecosmart/main
git checkout tmp-port
git cherry-pick <commit(s)>              # just the new commit(s), not a merge
npx tsc --noEmit                         # sanity-check it compiles on THIS base
git push ecosmart tmp-port:main
git checkout main
git branch -D tmp-port
git remote remove ecosmart
```

Hostinger's execution logs (hPanel → Logs de execução) are the only way to see
server-side runtime errors from a deployed change — there's no way to tail them
from here.

**Hosted on Hostinger, not Vercel** — old code comments saying "we run on Vercel"
refer to the upstream template's own demo site, not this fork.

**CDN caching gotcha**: Hostinger's edge layer was observed caching full HTML
responses (`Cache-Control: public, s-maxage=300`) even for pages whose content
now varies per-user (the locale cookie) — this leaked one visitor's language to
every other visitor for up to 5 minutes in production. `src/middleware.ts` now
force-sets `Cache-Control: private, no-store` + `Vary: Cookie` on every response
to prevent this. Keep that in mind before adding any other per-cookie/per-user
server-rendered content.

## Database — migrations don't apply themselves

Files in `supabase/migrations/*.sql` are not run automatically anywhere — no
CI/CD step applies them. After merging a migration, someone has to run it by
hand against the actual Supabase project (SQL Editor, or CLI) — the project ref
is in `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL`. Until that happens, any code
that assumes the new columns exist will 500 in production with a Postgres
`42703 column does not exist` error (visible in Hostinger's execution logs).

## Architecture — WhatsApp providers

`whatsapp_config` is one row per account (`UNIQUE(account_id)`), with a
`provider` discriminator column: `'meta' | 'uazapi' | 'evolution'`. There's no
plugin/registry abstraction — each provider is a hardcoded branch
(`if (config.provider === 'uazapi')` etc.) duplicated across roughly nine files.
This is intentional (see the comments in migrations `037_uazapi_provider.sql` /
`038_evolution_provider.sql` for the rationale). Follow the same shape for a new
provider:

- A migration adding nullable `<provider>_*` columns to `whatsapp_config`.
- `src/lib/whatsapp/<provider>-api.ts` — HTTP client, named-params-object
  functions (avoids swapped-positional-arg bugs).
- A new branch in `loadWhatsAppConfig()` (`src/lib/whatsapp/provider-config.ts`).
- `src/app/api/whatsapp/config/<provider>/{route,connect/route}.ts`.
- A new branch in every send dispatch site: `send-message.ts`,
  `broadcast-core.ts`, `broadcast/route.ts`, `automations/meta-send.ts`,
  `flows/meta-send.ts`, `react/route.ts`.
- UI wiring in `whatsapp-config.tsx` + both `messages/*.json`.

Inbound webhooks normalize into a shared pipeline —
`src/lib/whatsapp/inbound-pipeline.ts` (`NormalizedInboundMessage` +
`processInboundMessage()`) — added while building the Evolution provider so
contact/conversation/automation dispatch logic isn't re-implemented per
provider. A new provider's webhook route should parse its payload into that
shared type rather than hand-rolling the pipeline again.

## i18n

`next-intl`, locale resolved from a `wacrm.locale` cookie in
`src/i18n/request.ts` — not URL-based routing (no `[locale]` route segment).
Two dictionaries, `messages/en.json` and `messages/pt.json`, kept in exact
structural + ICU-placeholder parity (same leaf-key set, same `{variables}`).
When adding a translation key, add it to both files.
