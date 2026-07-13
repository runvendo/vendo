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

## User authentication
- `vendo cloud login EMAIL` → sends a 6-digit email OTP, prompts for the code,
  and stores the returned session in `~/.vendo/cloud-session.json`
- `vendo cloud login --token <jwt>` → stores an access-token-only fallback session

## User principal (stored session or --token JWT)
- `vendo cloud whoami --token <jwt>` → `{ orgs: [{id,name,role}] }`
- `vendo cloud keys list --org <id> --token <jwt>` → `{ keys: [...] }`
- `vendo cloud deployments --org <id> --token <jwt>` → `{ deployments: [...] }`

All shapes match the frozen flowlet wave-2 contracts; the 402 `cloud-required`
envelope is surfaced as a friendly message. Verified 2026-07-13.
