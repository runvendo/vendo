# Block: @vendoai/actions — everything extraction isn't (design)

Date: 2026-07-14. Approved by Yousef in the block-actions orchestrator brainstorm.
Linear project: "Block: @vendoai/actions — everything extraction isn't" (ENG).

This spec is the source of truth for the project. It supersedes the frozen
contracts where they conflict; a contracts-amendment PR is part of the scope.
Child sessions read this spec and do not re-litigate decisions recorded here.

## Outcome

The actions block fully implements its vision beyond extraction:
execute-as-the-signed-in-user that actually forwards credentials, a complete
actAs seam with per-auth-provider presets proven end-to-end (including away
execution), per-user connected accounts for external connectors, real
principals (anonymous upgrade, away re-verification, orgs), and sync that
tells you what a change breaks before it breaks it.

## Grounding (examination findings, 2026-07-14)

Four code-reading agents examined main. Load-bearing facts:

- The `ActAs` seam is defined, consumed by the away and MCP branches, and has
  **zero implementations anywhere** — no preset, no demo wiring, no quickstart
  example. Both demo hosts are present-only with fake fixed-user auth.
- Present-mode credential forwarding is silently disabled unless the operator
  sets `VENDO_BASE_URL`; away execution hard-requires a grant captured while
  present. Neither rule is documented.
- Composio and MCP connectors are **live and contract-named**, with guard
  parity at the decision layer. But Composio hardcodes every tool to
  `risk:"write"` (destructive ops never hit the forced-ask gate) and the MCP
  connector sends one shared static credential for every principal.
- `vendo sync` + `--strict` + a real breaking-change diff engine **exist**.
  Missing: blast-radius (contract defers to a "runtime query over vendo_apps"
  that was never built), any surfacing of silent grant invalidation
  (descriptor hash changes silently unmatch grants → bare re-prompt), and
  build-step scaffolding (init does not add predev/prebuild).
- Principals: no anonymous→signed-in migration (work silently lost on
  sign-in); away principals are rebuilt from a subject string with no
  re-verification; `webhook:` synthetic subjects can collide with real ones;
  no `grant.subject === ctx.principal.subject` check at the actAs seam;
  `kind:"org"` reserved but unbuilt.

## Framing decisions

- **This brainstorm wins** over docs/contracts and the Notion vision page;
  contracts get amended to match.
- All remaining **sync work lives here** (extraction project keeps only
  extraction quality).
- Quality bar: real captured demos — both demo hosts, the MCP venue, at least
  one live external connector, and an away-execution drill. Not just unit
  tests.
- Cloud alignment commitments (all four accepted): audit enrichment for guard
  console/insights, zero-key connect behind VENDO_API_KEY, key-gated orgs,
  blast-radius report pushable to the console.

## A. actAs complete (wave 1)

- New subpath `@vendoai/actions/presets` with **both tiers**: shipped preset
  code for the four first-class providers — Auth.js/NextAuth, Clerk, Supabase
  Auth, Auth0 — plus a generic JWT preset, and documented copy-paste recipes
  for the long tail.
- **Away works for all four.** Mechanism per provider: native user-token
  minting with the host's own secrets where offline minting is possible
  (Auth.js secret, Supabase project JWT secret); where it isn't (Auth0 RS256,
  Clerk), the preset ships **both halves** — an actAs producer that signs a
  short-lived Vendo away-token plus a small verify-middleware (Next and
  Express flavors) the host mounts on its API.
- Token caching lives inside preset closures until expiry. `AuthMaterial`
  stays `{ headers }` — no contract change.
- Provider SDKs are optional peer deps of the subpath only; dependency-guard
  layering holds.
- Demo conversions: Maple (demo-bank) → real Auth.js login (credentials
  provider, seeded demo users, real session tokens); Cadence
  (demo-accounting) → Supabase Auth (Supabase local in dev/CI). Clerk and
  Auth0 get minimal e2e fixture hosts booting real createVendo, with
  live-keyed tests skipped when credentials are absent.
- Silent-trap fixes in product: `vendo init` writes `VENDO_BASE_URL`; doctor
  gains live probes (credentials actually arrive at the host API; actAs
  mint+verify round-trips); runtime emits one structured warning when present
  execution forwards nothing despite inbound auth headers; the
  away-needs-present-grant rule is documented.
- Impersonation guard lands here: assert `grant.subject ===
  ctx.principal.subject` at the actAs seam.

## B. Connected accounts + connector identity (wave 2)

- **Composio is the sole broker.** No home-grown OAuth flows; per-user
  connections ride Composio connected accounts (entityId = subject).
- Umbrella gains connection endpoints: initiate (returns Composio redirect
  URL), status, disconnect — all per-principal.
- In-flow UX: a Composio call failing on a missing connection produces a
  typed `connect-required` tool outcome the UI renders as an inline connect
  card (approvals pattern); after connecting, the call retries.
- Persistent connected-accounts panel (list + disconnect) in VendoRoot chrome
  settings. Both surfaces brand-native.
- Composio risk fix: curated slug-pattern risk map (delete/remove/destroy →
  destructive, etc.) plus Composio metadata where available; conservative
  `write` default; `overrides.json` still wins.
- MCP connector: `headers` becomes an optional async per-principal resolver;
  presence/grant context is passed through to connector execute. Shared
  static headers remain the simple default.
- Cloud: with VENDO_API_KEY, connections ride a Vendo Cloud broker endpoint
  using Vendo's Composio credentials — cloud users bring zero API keys. OSS
  stays BYO-Composio-key.

## C. Principals + orgs (wave 2)

- **Anonymous→signed-in auto-merge**: first authenticated request carrying a
  valid anon cookie migrates threads/apps/state to the real subject, clears
  the cookie, idempotent. Grants and approvals deliberately do NOT migrate —
  consent doesn't transfer identities; users re-approve.
- **Away re-verification rides actAs**: the host declining to mint (null)
  fails the run closed. No second verification seam.
- Webhook principals get a reserved namespace (`vendo:webhook:…`); host
  principal resolvers are forbidden from producing reserved subjects.
- **Full org semantics, Vendo-owned tables**: `vendo_orgs` +
  `vendo_org_members` (roles owner/admin/member) in @vendoai/store;
  `kind:"org"` principals become real; apps/automations ownable by an org
  subject; members run, admins approve and manage; minimal org management UI
  (create/invite/roles) in chrome.
- **Org stays paid**: all machinery ships OSS, activation is gated on
  VENDO_API_KEY entitlement via the console's existing /keys/validate;
  without a key, org APIs return a posture error. The Cloud
  collaboration theme shrinks to console UX on top of this.

## D. Sync completion (wave 1)

- **Blast-radius**: a posture-gated runtime endpoint on the umbrella maps
  each breaking/changed tool to the saved apps, automations, and standing
  grants that reference it. `vendo sync` queries it when the dev server is
  reachable and prints per-tool impact ("breaks N automations, M grants");
  graceful "impact unknown — server not running" fallback.
- **Loud grant invalidation**: a descriptor-hash mismatch at runtime emits an
  audit event and a UI notice instead of a silent re-prompt.
- `vendo init` scaffolds `predev`/`prebuild` sync hooks into the host
  package.json (permission-prompted, like route wiring).
- `--strict` gains distinct exit codes for breaking-extraction vs
  blast-radius-nonzero. `--report` optionally pushes the report to the Cloud
  console with a key.

## Cross-cutting

- **Audit enrichment** on every action/actAs/connector execution: grant id,
  actAs outcome, connector account identity, away trigger, org context —
  exactly what guard console and insights will consume. OSS emits, Cloud
  reads.
- **One contracts-amendment PR**: 04-actions (presets exist, trust model
  documented, MCP-as-actAs cross-referenced), 01-core (org principals),
  02-store (org tables, migration semantics). The "no adapter framework"
  disclaimer is removed.
- Testing bar per child: unit + integration fixtures + browser e2e; live
  external tests keyed and skipIf-gated; UI-affecting changes verified in a
  real browser with screenshots in the PR; `pnpm build && pnpm test &&
  pnpm typecheck && pnpm lint` green before any PR.

## Execution structure

- **Four child Orca sessions** (Fable orchestrators under the parent,
  executing via codex sol; Opus 4.8 only when sol is usage-blocked):
  child A (actAs), child B (connected accounts), child C (principals+orgs),
  child D (sync).
- **Waves**: wave 1 = A + D in parallel; wave 2 = B + C once real demo auth
  exists (B's honest demos need signed-in users; C's merge interacts with
  B's per-subject connections).
- **Parent owns**: child management and monitoring, sequencing, integration,
  the contracts-amendment PR, Linear issues (one per chunk + one for the
  demo/GIF wave), and the final GIF wave.
- **GIF wave** (parent-run, end of project): Maple real-login execution;
  Cadence Supabase execution; away drill — an automation firing with no live
  user session; live Gmail connect + send via Composio; MCP venue (external
  agent acting through actions).
