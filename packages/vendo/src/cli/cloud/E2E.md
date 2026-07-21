# vendo cloud — live e2e (console.vendo.run)

Run against the production Vendo Cloud API. Machine commands use a valid
VENDO_API_KEY; user commands use a stored email-OTP session or the `--token
<supabase access jwt>` fallback. There is no validate endpoint or client-side
pre-check: the server checks key validity and meters on every call, and key
problems surface as per-call errors.

## Machine principal (VENDO_API_KEY)

`vendo cloud` has no machine commands left. The `share`/`publish`/`pin-ship`
CLI wrappers were removed; sharing and publishing happen through the server
runtime (`vendo.apps.share` / `vendo.apps.publish`), whose hosted endpoints are
unchanged. There is also no `vendo cloud deploy` command and no
`/api/v1/hosted/deploy` endpoint (deleted server-side; it now 404s) — see
"Hosted runtime sync" below.

## Hosted runtime sync (wave 2+)

With `VENDO_API_KEY` set, enabled automations sync to the hosted store
automatically as you save them and run on Vendo's own schedulers and
Composio-delivered external triggers. See `docs-site/deploy/vendo-cloud.mdx`
for the current behavior.

## User authentication
- `vendo login [EMAIL]` (alias: `vendo cloud device-login`) → the auth.md
  user-claimed ceremony: prints the approval URL + pairing code (opens the
  browser on a TTY), polls the token endpoint, and writes the minted
  `VENDO_API_KEY` to `.env.local` (never printed)
- `vendo cloud login EMAIL` → fallback: sends an email OTP (6-10 digits; this
  Supabase project issues 8-digit codes), prompts for the code,
  and stores the returned session in `~/.vendo/cloud-session.json`
- `vendo cloud login --token <jwt>` → stores an access-token-only fallback session

## User principal (stored session or --token JWT)
- `vendo cloud whoami --token <jwt>` → `{ orgs: [{id,name,role}] }`
- `vendo cloud keys list --org <id> --token <jwt>` → `{ keys: [...] }`

All shapes match the frozen flowlet wave-2 contracts; the 402 `cloud-required`
envelope is surfaced as a friendly message. The auth/share/publish flows were
verified live on 2026-07-13.

## Request identity (2026-07-17 realignment)

- malformed keys (`^vnd_[0-9a-f]{40}$` mismatch) fail before any request;
  every cloud request sends `User-Agent: vendo-cli/<version>`
- every key-authed request carries the deployment-identity headers
  `X-Vendo-Deployment-Host` (machine hostname) and `X-Vendo-Deployment-Name`
  (cwd package name, directory-name fallback), sanitized to printable ASCII;
  the console upserts its deployment inventory and meters usage from these
  headers on real service calls
- envelope-less 401 surfaces as `Invalid or revoked API key (401)`; there is
  no local entitlements cache to evict
