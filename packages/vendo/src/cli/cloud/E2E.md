# vendo cloud — live e2e (console.vendo.run)

Run against the production Vendo Cloud API. Machine commands use an entitled
VENDO_API_KEY; user commands use a stored email-OTP session or the `--token
<supabase access jwt>` fallback.

## Machine principal (VENDO_API_KEY)
- `vendo cloud validate` (entitled key) → `{valid:true, entitlements:{sharing,insights,hosted_adapters,seats:10}}`
- `vendo cloud validate` (free-plan key) → entitlements all false / seats 1
- `vendo cloud share app.json` (entitled) → `ShareSnapshot { id: shr_…, doc, createdAt }`
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

## Entitlement contract v2 (ENG-305/306/307)

`vendo cloud validate` on a `contract_version: 2` response renders plan
(informational only — never gated on), the nine capabilities, and per-meter
quota bars; `--json` prints the raw contract. Entitlements are cached in
`~/.vendo/entitlements.json` (0600, keyed by sha256(apiUrl+key)):

- fresh within `cache.ttl_seconds` (600) for programmatic consumers;
  `validate` itself always revalidates live
- 503/network failure → cached contract served with a
  `stale since <ISO> (console unreachable)` banner (exit 0) within
  `stale_if_error_seconds` (24h)
- past 24h unreachable → degrades to free entitlements, renders
  `Vendo Cloud key: unverified (offline)` (exit 1, fail-closed meters)
- 401 → cache entry dropped immediately; envelope-less 401 surfaces as
  `Invalid or revoked API key (401)`
- free-tier `storage_gb` arrives `exhausted: true` from day one — rendered
  as no-headroom, not an error (exit stays 0)
- malformed keys (`^vnd_[0-9a-f]{40}$` mismatch) fail before any request;
  every cloud request sends `User-Agent: vendo-cli/<version>`

Verified 2026-07-14 live against the console contract-v2 spine
(vendo-web@5cb58dc run locally: supabase local + `next dev`): signup → OTP
login (Mailpit) → `keys create` → validate free + pro, `--json`, stale,
degrade-to-free, and 401 eviction, all through the real HTTP seam. Production
console re-verification pending the ENG-318 migration deploy.
