# vendo cloud — live e2e (console.vendo.run)

Run against the production Vendo Cloud API. Machine commands use a valid
VENDO_API_KEY; user commands use a stored email-OTP session or the `--token
<supabase access jwt>` fallback. There is no validate endpoint or client-side
pre-check: the server checks key validity and meters on every call, and key
problems surface as per-call errors.

## Machine principal (VENDO_API_KEY)
- `vendo cloud share app.json` (valid key) → `ShareSnapshot { id: shr_…, doc, createdAt }`
- `vendo cloud share app.json` (free) → "This key's org needs a Cloud plan (cloud-required)." (HTTP 402)
- `vendo cloud publish app.json` ×2 → `PublishRecord` version "1" then "2" (monotonic)
- `vendo cloud pin-ship --app app_cli --slot hero --base sha256:aa --diff d` → `{ id: pin_…, status: "pending" }`

## Hosted runtime deploy

`vendo cloud deploy` opens the local project's default PGlite store at
`.vendo/data` and deploys every enabled automation for its sole subject. If the
store contains more than one subject, pass `--subject <subject>`; the command
never combines apps or grants from different subjects.

- `vendo cloud deploy --key vnd_…` → concise applied-count and hosted-webhook table
- `vendo cloud deploy --key vnd_… --json` → raw hosted deploy response
- `vendo cloud deploy --app app_daily --app app_webhook` → restrict the deploy;
  an explicitly selected disabled automation is sent with `enabled: false`
- `vendo cloud deploy --secret STRIPE_KEY=sk_… --secret RESEND_KEY=re_…` → send
  only values whose names are referenced by the selected app documents

The request is `POST /api/v1/hosted/deploy` with machine-key bearer auth and
the exact body `{ apps: [{ doc, enabled }], grants, secrets: [{ name, value }] }`.
Only active grants with `source: "automation"`, the selected subject, and an
`appId` in the deployed set are included.

Stored secret values are encrypted and the local encryption key is deliberately
not discoverable through the CLI contract. The v1 deploy vehicle is therefore
the repeatable `--secret NAME=VALUE` flag; values cross only the authenticated
TLS request and are never printed. A referenced name without a matching flag
produces a warning and does not fail the app/grant deploy.
Automations with `steps[].tool` beginning `fn:` also warn per app: those steps
target the app's machine, which hosted sandboxes cannot reach in v1, so they
will fail/park when fired hosted without blocking the deploy itself.

## User authentication
- `vendo cloud login EMAIL` → sends an email OTP (6-10 digits; this Supabase
  project issues 8-digit codes), prompts for the code,
  and stores the returned session in `~/.vendo/cloud-session.json`
- `vendo cloud login --token <jwt>` → stores an access-token-only fallback session

## User principal (stored session or --token JWT)
- `vendo cloud whoami --token <jwt>` → `{ orgs: [{id,name,role}] }`
- `vendo cloud keys list --org <id> --token <jwt>` → `{ keys: [...] }`
- `vendo cloud deployments --org <id> --token <jwt>` → `{ deployments: [...] }`

All shapes match the frozen flowlet wave-2 contracts; the 402 `cloud-required`
envelope is surfaced as a friendly message. The auth/share/publish flows were
verified live on 2026-07-13; hosted deploy has deterministic local-store and
mocked-wire coverage pending the console-side production endpoint.

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
