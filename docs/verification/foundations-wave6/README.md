# Wave 6 — captured demos (ENG-239)

Part 1 (Wave 6a, Cadence) and part 2 (Wave 6b, Maple) below.

# Wave 6a — Cadence captured demos (ENG-239, part 1 of 2)

Captured 2026-07-16 on the Cadence demo host (`apps/demo-accounting`), per the
Wave 6 section of `docs/superpowers/specs/2026-07-14-block-foundations-design.md`.
The Maple beats (provider-swap, resilience drills) are owned by a separate
worker. All captures are local: `next dev` on `localhost:3000`, a throwaway
Homebrew Postgres 18 cluster on port 54329, session minted offline (HS256
against the well-known `supabase start` JWT secret — no Supabase stack needed).

No source changes ship with this PR. The Postgres leg needed a two-line
uncommitted wire-up in `apps/demo-accounting/src/vendo/server.ts` (reverted
after capture; reproduction below) because the contract deliberately defines no
storage env-var alias — hosts pass `createStore({ url })` explicitly
(`docs-site/reference/environment-variables.mdx`).

## Beat A — Postgres-swap (`postgres-swap/`)

**What was captured**

1. **PGlite default** — `createVendo` with no store config writes to
   `.vendo/data`. `01-pglite-home.png` shows the Cadence dashboard logged in as
   Maya Alvarez; `02-pglite-vendo-chat.png` shows the Vendo panel completing a
   chase-list request with live `host_getDashboard` / `host_listDeadlines` tool
   calls on that default store. `04-pglite-store-sql.txt` lists the PGlite data
   dir and queries all 15 `vendo_*` tables through the store handle
   (`query-store.mjs`).
2. **Real Postgres** — the same host booted with
   `store: createStore({ url: process.env.POSTGRES_URL })`. On boot it created
   the full `vendo_*` schema in Postgres; `03-postgres-vendo-chat.png` shows the
   same conversation flow working against it.
3. **Host-side SQL** — `05-postgres-psql.txt` is a real `psql` transcript:
   `\dt`, the persisted `vendo_threads` row (subject = Maya's Supabase uuid),
   per-table row counts, audit rows — plus a restart-survival addendum (server
   stopped and rebooted on the same `POSTGRES_URL`; the host API lists the same
   thread).

**Reproduce**

```bash
# PGlite default
set -a; source <keys>.env; set +a          # ANTHROPIC_API_KEY
VENDO_BASE_URL=http://localhost:3000 pnpm --filter demo-accounting dev
# (VENDO_BASE_URL must be set: present credentials only forward to a TRUSTED base URL)

# Postgres swap: start any local Postgres, then add to src/vendo/server.ts:
#   import { createStore } from "@vendoai/store";
#   const postgresUrl = process.env.POSTGRES_URL;
#   createVendo({ ...(postgresUrl ? { store: createStore({ url: postgresUrl }) } : {}), ... })
POSTGRES_URL=postgres://vendo@127.0.0.1:54329/vendo_cadence \
  VENDO_BASE_URL=http://localhost:3000 pnpm --filter demo-accounting dev

# Host-side SQL (either backend), from apps/demo-accounting:
node ../../docs/verification/foundations-wave6/postgres-swap/query-store.mjs pglite .vendo/data
node ../../docs/verification/foundations-wave6/postgres-swap/query-store.mjs pg "$POSTGRES_URL"
psql "$POSTGRES_URL" -c '\dt'
```

**Files**: `01-pglite-home.png`, `02-pglite-vendo-chat.png`,
`03-postgres-vendo-chat.png`, `04-pglite-store-sql.txt`,
`05-postgres-psql.txt`, `query-store.mjs`.

**Finding (flagged for follow-up, not fixed here):** under `next dev`
(Turbopack), turns persisted through the composed stack were visible via the
host API but never reached the PGlite files on disk — nothing under
`.vendo/data` changed after boot, and threads did not survive a dev-server
restart. One `SIGTERM` mid-run also left the data dir unopenable (PGlite
`RuntimeError: Aborted()` on reopen). The identical flow on Postgres persists
durably and survives restarts (see `05-postgres-psql.txt`), and the store's own
SIGKILL durability drill (`packages/store/src/durability.drill.test.ts`) passes
in plain node — so this looks specific to the Next dev-server runtime (likely a
second in-process PGlite instance after HMR, or an unflushed WASM VFS), not to
the store. Worth a ticket; out of scope for a capture-only PR.

## Beat B — Encryption / retention proof (`encryption-retention/`)

**What was captured** — `01-encryption-retention-transcript.txt`, produced by
`encryption-retention-demo.mjs` against the same local Postgres the host used
(Maya's beat-A thread is visible in the erase counts):

1. **Ciphertext at rest** — two secrets written through
   `secretStore(store).set(...)` with a fresh 32-byte key; raw SQL shows only
   `v2:<iv>:<tag>:<ciphertext>` envelopes, the plaintext appears nowhere, and
   `storeSecrets(store).get(...)` decrypts correctly with the configured key.
   The external `psql` view at the end shows the same envelopes.
2. **AAD tamper rejection** — swapping one row's ciphertext into another row
   via raw SQL makes the read fail (`Stored secret could not be decrypted`):
   the v2 envelope binds the secret NAME as AES-GCM AAD, so a swapped
   ciphertext fails the auth tag instead of decrypting to the wrong secret.
   A direct bit-flip on the ciphertext is rejected the same way.
3. **Erase API** — two subjects seeded across `vendo_threads` and
   `vendo_grants`; `eraseStore(store).bySubject(...)` removes exactly the
   target subject's rows (report: `{"vendo_threads":2,"vendo_grants":1}`),
   before/after counts show the other subject's data intact.

**Reproduce** (from `apps/demo-accounting`, any Postgres URL):

```bash
WAVE6_ENC_KEY=$(openssl rand -base64 32) node \
  ../../docs/verification/foundations-wave6/encryption-retention/encryption-retention-demo.mjs \
  "postgres://vendo@127.0.0.1:54329/vendo_cadence"
```

**Files**: `01-encryption-retention-transcript.txt`,
`encryption-retention-demo.mjs`.

## Parked beats (Cadence)

None — all Cadence beats captured.

# Wave 6b — Maple captured demos (ENG-239, part 2 of 2)

Captured 2026-07-16 on the Maple demo host (`apps/demo-bank`), per the Wave 6
section of the same spec. All captures are local: `next dev` on
`localhost:3000` driven through a real browser session logged in as the demo
user (`yousef@maple.com`), plus scripted wire/`psql` transcripts. The
resilience beats run on a throwaway Homebrew Postgres 18 cluster
(`postgres://vendo@127.0.0.1:54331/vendo_maple` via the host's own
`VENDO_DATABASE_URL` knob — no source change needed for the store swap).

No source changes ship with this PR. The provider-swap and churn beats needed
a small uncommitted wire-up in `apps/demo-bank/src/vendo/server.ts` (reverted
after capture; reproduction below) because the demo host hardcodes
`anthropic(...)` as its model and passes no `sessions` config — both are
`createVendo` inputs the host owns, not env-configurable surface.

**Temp wire-up used for capture (uncommitted, reverted):**

```ts
// package.json (demo-bank): + @ai-sdk/openai@3.0.9, @ai-sdk/openai-compatible@2.0.9
const demoProvider = process.env.VENDO_DEMO_PROVIDER ?? "anthropic";
const model = demoProvider === "openai"
  ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(process.env.VENDO_DEMO_MODEL ?? "gpt-4.1")
  : demoProvider === "proxy"
    ? createOpenAI({ baseURL: process.env.VENDO_PROXY_URL ?? "http://127.0.0.1:8787/v1",
        apiKey: "proxy-dummy-key" })(process.env.VENDO_DEMO_MODEL ?? "gpt-4.1")
    : anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6");
// createVendo({ ..., ...(process.env.VENDO_SESSIONS_MAX ? { sessions: {
//   maxSessions: Number(process.env.VENDO_SESSIONS_MAX),
//   ttlMs: Number(process.env.VENDO_SESSIONS_TTL_MS ?? 60_000),
//   sweepIntervalMs: Number(process.env.VENDO_SESSIONS_SWEEP_MS ?? 5_000) } } : {}) })
```

## Beat A — Provider-swap (`provider-swap/`)

**What was captured** — the same conversation ("Where did my spending go this
month? Show it by category.") completing with a live `host_getSpendingInsights`
tool call on three providers, one dev-server run each:

1. **Anthropic** (`claude-sonnet-4-6`, the demo default) —
   `01-anthropic-chat.png`, server log `02-anthropic-server-log.txt`.
2. **OpenAI** (`gpt-4.1-mini` via `@ai-sdk/openai`) — `03-openai-chat.png`,
   `04-openai-server-log.txt` (the `[wave6b] provider=openai` boot line is the
   temp wire-up's marker).
3. **OpenAI-compatible proxy** — `openai-passthrough-proxy.mjs`, a trivial
   local pass-through in front of api.openai.com that injects the upstream key
   server-side (the host only holds the proxy URL and a dummy key, same shape
   as a corporate LLM gateway; the host process ran with `OPENAI_API_KEY`
   unset). `05-proxy-chat.png` shows the same flow; `06-proxy-request-log.txt`
   is the proxy's own request log proving the turn's two `POST /v1/responses`
   calls went through it; `07-proxy-server-log.txt` the host side.

**Reproduce**

```bash
set -a; source <keys>.env; set +a            # ANTHROPIC_API_KEY / OPENAI_API_KEY
# apply the temp wire-up above, then per leg:
VENDO_BASE_URL=http://localhost:3000 pnpm --filter demo-bank dev
VENDO_DEMO_PROVIDER=openai VENDO_DEMO_MODEL=gpt-4.1-mini VENDO_BASE_URL=... pnpm --filter demo-bank dev
node docs/verification/foundations-wave6/provider-swap/openai-passthrough-proxy.mjs 8787 &
VENDO_DEMO_PROVIDER=proxy VENDO_DEMO_MODEL=gpt-4.1-mini VENDO_BASE_URL=... pnpm --filter demo-bank dev
```

**Files**: `01-anthropic-chat.png`, `02-anthropic-server-log.txt`,
`03-openai-chat.png`, `04-openai-server-log.txt`, `05-proxy-chat.png`,
`06-proxy-request-log.txt`, `07-proxy-server-log.txt`,
`openai-passthrough-proxy.mjs`.

**Findings (flagged, not fixed here):**

- `@ai-sdk/openai-compatible` speaks the Chat Completions API, and OpenAI
  rejects Maple's tool surface over it: `Invalid 'tools': array too long.
  Expected an array with maximum length 128, but got an array with length
  184` (the 400 in `06-proxy-request-log.txt`). The proxy leg therefore uses
  `createOpenAI({ baseURL })` (Responses API) through the same proxy. Hosts
  with large tool surfaces cannot use Chat-Completions-only gateways today —
  worth a docs note or a tool-cap strategy.
- gpt-4.1 (non-mini) on a low-TPM org also rejects the turn outright:
  the composed prompt + 184 tools weighs ~41k tokens against a 30k TPM cap.
  Same conclusion: the default tool surface is heavy; gpt-4.1-mini works.

## Beat B — Kill-the-server + restart-and-resume (`resilience/`)

**What was captured** — `01-before-kill.png` shows a turn completing on the
composed stack (Postgres store): "I'm saving for a trip to Kyoto in November
and want to free up $300 a month…" with `host_getSpendingInsights` +
`host_getBudgets` tool calls. `02-kill-restart-resume-transcript.txt` then
records, with timestamps: the persisted `vendo_threads` row, `kill -9` of the
dev server (curl → connection refused), a restart on the same
`VENDO_DATABASE_URL`, and the SAME thread resumed over the wire
(`POST /api/vendo/threads` with the pre-kill `threadId`) — the assistant
answers "Kyoto / November / $300" from stored history, and
`GET /threads/<id>` shows the full four-message history after the restart.

Note: `next dev` force-reloads the browser page when its websocket
reconnects after a restart, so the in-page client starts a fresh composer;
the resume is therefore demonstrated over the wire (the same client-visible
surface the UI uses). Thread history, tool results, and title all survive the
SIGKILL because every turn is persisted through the store before the response
finishes.

**Reproduce** (from the repo root, any Postgres URL):

```bash
VENDO_DATABASE_URL=postgres://vendo@127.0.0.1:54331/vendo_maple \
  VENDO_BASE_URL=http://localhost:3000 pnpm --filter demo-bank dev
# chat once in /vendo, then: kill -9 $(lsof -ti tcp:3000 -sTCP:LISTEN); restart same command
curl http://localhost:3000/api/vendo/threads -H "cookie: <session>" \
  -d '{"threadId":"<pre-kill id>","message":{"id":"m1","role":"user","parts":[{"type":"text","text":"..."}]}}' \
  -H "content-type: application/json"
```

**Files**: `01-before-kill.png`, `02-kill-restart-resume-transcript.txt`.

## Beat C — Memory flat under anonymous-session churn (`resilience/`)

**What was captured** — `03-session-churn-transcript.txt`, produced by
`session-churn.mjs`: 5,000 cookie-less requests against the wire (each mints a
FRESH anonymous principal and registers it in the ENG-237 TTL/LRU session
registry; the script asserts every response carries a fresh
`vendo_anon_session` Set-Cookie), with the dev-server process RSS sampled
every 250 sessions and through a 90 s TTL+sweep settle window afterwards.
Sessions config for the drill: `maxSessions=500`, `ttlMs=60s`, `sweep=5s`
(the env-gated temp wire-up above), i.e. the churn is 10× the cap.

Result: RSS warms up to ~565 MB by session 750 (route compilation + V8 heap
growth), then stays flat — 565–582 MB — for the remaining 4,250 sessions and
the settle window. 0 failed requests, 0 responses without a fresh session.
Memory does not grow with total sessions churned; the registry cap + idle
sweep bound it.

**Reproduce** (server running with the sessions override):

```bash
node docs/verification/foundations-wave6/resilience/session-churn.mjs \
  --sessions 5000 --concurrency 10 --sample-every 250 --settle-seconds 90
```

**Files**: `03-session-churn-transcript.txt`, `session-churn.mjs`.

## Parked beats (Maple)

- **Beat D — client disconnect visibly cancels the loop**: blocked on ENG-238
  merge — the wave-5 AbortSignal work is not yet on main (coordinator
  confirmed 2026-07-16), so there is no disconnect-to-cancellation path to
  capture. Follow-up capture after wave 5 lands: disconnect mid-generation,
  show the loop stops server-side (log line + no further provider calls).
