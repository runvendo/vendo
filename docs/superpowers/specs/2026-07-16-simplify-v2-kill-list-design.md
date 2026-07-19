# Simplify v2 — the kill-list

Date: 2026-07-16
Status: decided with Yousef in one sitting (simplify-v2 lane of the microapps v2 overhaul)
Feeds: the v2 contract re-derivation (merge point with the format-gen-v2 lane)

> **Reading notes** (added 2026-07-17 at review): package paths below are
> relative to `packages/` (`apps/src/machine.ts` = `packages/apps/src/machine.ts`
> — distinct from the repo-root `apps/` demo directory). Line counts are
> audit-stage estimates that guided scoping; the measured actuals live in the
> per-task commits and the PR #340 checkpoint reports, which supersede these
> numbers where they differ.

## Context

Microapps v2 is a from-first-principles rebuild. Contracts are unfrozen; breaking
changes are allowed everywhere. This lane's job was to decide, from first
principles, what the current implementation cuts, shrinks, or keeps. Four
parallel audits swept every package (~39k non-test source lines). Roughly a
quarter of that is condemned machinery, speculative sub-features, brittle
hand-rolled parsers, or structural duplication.

Decisions from the parent overhaul that this list builds on (locked, not
revisited here): one machine per app with edits applied in place; generation
rebuilt for <1s first paint / <10s completion; Cloud-preferred sandbox and
hosted inference; per-edit and app-CRUD permissions removed.

## Principles (the knife)

1. **Permissions guard the host boundary, not Vendo's internals.** Host-API
   calls made as the user keep the full deny/allow/ask + grants + audit +
   inputPreview floor. The agent creating or editing the user's own app never
   asks permission — principal scoping already contains it.
2. **Regex matches little strings; parsers parse code.** Glob patterns, tool-name
   humanization, domain checks: fine. Regex-scanning TypeScript, CSS, or JSON:
   banned. The repo already ships the TypeScript compiler API; use it.
3. **One machine per app, edited in place.** No forking a fresh sandbox per
   edit, no snapshot/swap, no resume covers. A brief "updating…" moment is an
   acceptable price.
4. **Cloud enabled = data stored with Vendo.** BYO-Postgres remains, but it is
   single-player only. Multiplayer features (orgs, sharing) are never
   implemented against the host's local store. (This supersedes the 2026-07-11
   "just rows in the host's Postgres" doctrine.)
5. **Build for a consumer that exists.** Features with no caller, no contract
   entry, and no prospect behind them are deleted, with the design noted for
   when a real consumer appears.

## A. Cut outright

### A1. Sandbox fork/swap/snapshot/resume machinery (~800 lines)
Condemned by the one-machine decision. Inventory:
`apps/src/machine.ts` (entire file: fork caches, jti-burn eviction, resume
branching), the edit path in `apps/src/runtime.ts:423-525` (fork → build →
probe → snapshot → cover screenshot → swap), the hand-written POSIX snippets at
`runtime.ts:213-258` that keep snapshots "serving", the rung-4 resuming/cover
path in `open.ts:204-223`, and `run-token-gate.ts` (the anti-replay jti set
whose only job is burning tokens on machine teardown; the run token itself
shrinks to a static per-run secret).

### A2. Edit dialects and the tree-op interpreter (~480 lines)
Condemned by the generation rebuild. `apps/src/engine.ts` `applyTreeOps`
(hand-rolled interpreter for 10 structured ops with cycle detection), the
tree-vs-code dialect router (regexes deciding whether an instruction "sounds
server-y"), and the nested two-attempt repair loops duplicated in both the
runtime and the engine. Replacement is whatever the format-gen-v2 lane ships;
this doc only records that nothing here survives.

### A3. `apps/src/incremental-tree.ts` (269 lines)
Hand-rolled streaming-JSON parser (plus markdown-fence stripping of model
output). Replaced wholesale by the v2 format/streaming design.

### A4. The permissions regex: constrained grant scopes (~90 lines)
`guard.ts:253` compiles a user-supplied regex from a grant's `matches`
constraint at policy-check time, with a JSON-pointer resolver and a ReDoS
guard defending the permission system from its own regexes. No product surface
ever mints one. The `constrained` GrantScope variant goes; `exact` and `tool`
scopes cover real use.

### A5. Orgs-in-OSS — the Cloud-residency mistake (~700–900 lines, six packages)
Built on the superseded doctrine (principle 4). Entitlement checking already
talks to the console correctly; the data layer is in the wrong place. Cut:
- `store`: `vendo_orgs` + `vendo_org_members` tables, `helpers/orgs.ts`,
  `transferAppSubject`, org branches in `erase.ts`
- `vendo/src/orgs.ts` (keep only the `cloud-required` seam response) and the
  org wire routes in `server.ts`
- `ui`: `use-orgs.ts` hook and org client bindings
- `guard.ts:488` org-principal approval branch
- `automations/engine.ts:469-472` org-owned-automation principal branch
- `core/principal.ts` org subjects — whether v2 core keeps a reserved `"org"`
  principal kind is a contract-re-derivation decision (see Handoffs)
Orgs live on the Vendo-hosted side (vendo-web console already has the full
management surface: members, roles, invites, keys, usage).

### A6. Speculative sub-features with no consumer (~450 lines)
- `actions/src/sync/catalog-ai.ts` (149): LLM catalog-copy seam; knob has no
  caller. (Justification corrected 2026-07-17: `vendo refine` does NOT author
  catalog copy — nothing does; the field is hand-edited today. The cut stands
  on the no-caller ground alone.)
- Scanner hook in guard (~85): adapter surface, zero in-repo consumers,
  contract itself says zero scanners ship in-box.
- Age-based erase sweep (`store/src/erase.ts:260-310`, ~50): contract scopes
  retention out.
- `core/src/open-enum.ts` (28): forward-compat casts, three call sites, solves
  a problem we don't have.
- ~~`actions/src/sync/common.ts:211-303` `fallbackModuleStatements` (~90)~~
  **CORRECTED during implementation (2026-07-17):** the audit premise was
  wrong — `es-module-lexer` throws on real TSX/JSX component files, so this
  "fallback" is the primary parser for pin-capture and route-scan on JSX.
  Cutting it broke four real tests (verified on a clean baseline). It stays,
  and dies naturally in B1 when route-scan/pins move onto the TypeScript AST.
- `resolveRisk` hook (~25): its single consumer is the app-tool permission
  path already removed.

### A7. Hand-rolled reimplementations of solved problems (~250 lines)
- `core/src/sha256.ts` (~100): from-scratch SHA-256 where `node:crypto` exists
  on every supported runtime.
- `apps/src/unified-diff.ts` (135): hand-rolled LCS diff with one consumer;
  a tiny dependency replaces it (or pin-diff rendering leaves OSS).
- `store/src/crypto.ts` v1 no-AAD legacy decrypt branch + base64 canonicality
  round-trip (~25): no v1 rows will exist in v2.

## B. Rebuild or shrink — same behavior, principled implementation

### B1. Extraction keeps its magic, loses its regexes (~570 lines shrink + rewrite)
`vendo init` scanning the host codebase and auto-wiring the API stays — it is
the install wow moment, and coverage stays across REST, tRPC, GraphQL, and Next
server actions (the GraphQL and server-actions extractors are coverage, not
cruft; NextCRM and Twenty-class hosts are real). What changes:
`route-scan.ts`'s ~30 verb-guessing regexes and the brace-walker toolkit in
`sync/common.ts` are rewritten on the TypeScript AST the package already uses
for tRPC and catalog scanning (where the contract mandates "regex forbidden"
and the code complies). The zod→JSON-Schema hand-interpreter
(`static-ts.ts:214-423`) narrows to the shapes the corpus proves. The pins
`StaticValueParser` (~150) moves onto the same AST. The corpus harness remains
the quality gate for all of it.

### B2. Theme extraction: from guessing engine to exact-or-model (~1,400 → ~200 lines)
`cli/theme/` today: hand-parsed CSS via brace-depth scanner, a hand-coded
OKLab→sRGB matrix, brand-color guessing via name-fragment scoring lists tuned
to specific apps, font regexes built out of interpolated source identifiers
(`next-fonts.ts`), and an accent-color popularity contest over Tailwind
utilities in up to 2,000 files. Measured ceiling after a dedicated accuracy
PR: 5/7 and 6/7 theme slots correct on our own demo apps — with silent wrong
answers as the failure mode.

Replacement (quality goes up, not down):
1. **Allowlist fast-path** — read conventional tokens directly
   (`--primary`, `--background`, `--font-sans`, shadcn/Tailwind conventions).
   Exact, not guessed; covers the majority of modern Next.js hosts.
2. **LLM pass otherwise** — Vendo-hosted inference is a locked v2 primitive:
   at init, the model reads `globals.css` + Tailwind config + root layout and
   fills `theme.json`. Beats fragment scoring on any design system, including
   unseen ones.
3. **Editable `theme.json` + one-glance confirm** — init shows the extracted
   palette; a rare miss is a ten-second fix, never a silent wrong brand.
Init questions only when the model is genuinely unsure; the common path stays
zero-question.

### B3. Ephemeral anonymous sessions: overlay → disk (~850 → ~100 lines)
The in-memory TTL/LRU overlay (`store/src/ephemeral.ts` plus the dual
memory/disk branch in every case of `routing.ts`, the tri-state path in
`records.ts`, and mirror loops in `erase.ts`) collapses to: anonymous rows go
to disk under `anon:` subjects, a periodic sweep deletes stale ones, and the
`server.ts` HMAC-signed anonymous cookie (~150 lines of sign/verify/
constant-time-compare) becomes an opaque random pointer — the store is the
source of truth, so the cookie needs no signature.

### B4. Wire handler: if-chain → route table (~200 lines of boilerplate)
`vendo/src/server.ts:602-1306` is one 750-line closure with ~55 inline
`if (method && path)` branches, each repeating context/parse/validate/envelope.
A `[method, pattern, handler]` table with one param-extraction pass keeps every
route and deletes the repetition. This is the single biggest readability win in
the umbrella.

### B5. Approval internals: keep the behavior, drop the armor (~150 lines)
Away approvals stay (an overnight automation waiting for a morning yes is a
real product moment). The internals shrink: the 9-field consume-and-replay
fingerprint (`guard.ts:918-964`) becomes match-by-approval-id, and the
hand-rolled promise-chain `AsyncLock` is replaced by the store's own
`claim`/`atomic` CAS primitives, which exist now and didn't when the lock was
written. Same shrink applies to `agent/src/threads.ts`: one store path instead
of dual memory/store, one guarded put instead of a five-attempt merge loop.

### B6. Duplication sweep (~150 lines)
Identical `stripServerAuthoritativeFields`/`stripForgedServerFields` twins, the
same cursor-drain pagination loop in four files, `isRecord` redefined in ~8
files, two near-identical 16-entry layout-candidate lists in `cli/theme/`, and
`humanize.ts`'s three overlapping arg formatters.

### B7. MCP OAuth server: narrow, don't rewrite (~150 lines)
The hand-rolled OAuth 2.1 authorization server stays (it exists for MCP-spec
requirements generic libraries don't cover, and dynamic client registration is
how real MCP clients connect — cutting it would break the door). Shrink only
the periphery: extract the 130-line inline consent HTML to a template, and
drop the duplicated theme→CSS mapping it admits to copying from ui.

## C. Keep untouched

- **The host-action approval floor**: deny/allow/ask policy, `exact`/`tool`
  grants, audit trail, inputPreview. Non-negotiable.
- **Away approvals** (behavior; see B5 for internals).
- **CAS/atomic revisions** in store: a Next.js host on Vercel is
  multi-instance against one Postgres; concurrent writes are real. (Keep the
  capability; B5 consolidates its consumers to one code path.)
- **Tool-search loadout and capability-miss reporting**: kept by Yousef's call;
  the Cloud console already has a `misses/export` surface. Capability-miss's
  PII-scrub regexes are principle-2-legitimate (matching little strings).
- **Vendo Auto judge and deterministic breakers**: part of the away-automation
  safety story; they live and die with automations, which live.
- **MCP door**: dynamic client registration, CIMD fetching (with its SSRF
  hardening), per-principal sessions (backs per-user connected accounts).
- **Share/publish, connected accounts, cli/cloud**: already on the correct
  Cloud-residency model (they POST to the console). Confirmed the org thread
  (A5) is the only residency mistake in the codebase.
- **Legitimate regex sites**: policy glob matching (`policy.ts:97`), tool-name
  humanization, MCP registry domain validation, OAuth header parsing.
- **`chrome-css.ts`** (1,356 lines): a design-system string, not logic.
- **Interchange (.vendoapp export/import)**: in contract; its machine-resume
  legs die with A1, the rest stays.
- **Automations, telemetry**: small (1,550 / 341 lines), no audit findings at
  kill-list altitude.

## Deferred / flagged, not decided

- **Pin drift→rebase replay** (`runtime.ts:881-994` + intent history + the
  `pins.ts` comment-blanker): a low-traffic sub-feature carrying an outsized
  parser. B1 moves its parser onto the AST; whether drift-rebase itself
  survives is a feature call Yousef explicitly declined to make in this lane.
- **Secret-egress + SSRF stack in apps** (~550 lines, one consumer, activated
  2026-07-14): kept for now (it guards real secret flow), but flagged for the
  re-derivation — its `ssrf.ts` "will relocate to core" note is speculative
  abstraction with zero adopters.

## Handoffs to the v2 contract re-derivation

1. **Vendo-hosted store backend does not exist** in either repo. Today the
   console validates keys but has nowhere to hold app/thread data. Building it
   is what makes "Cloud enabled = data with Vendo" (principle 4) true, and it
   is the prerequisite for re-homing orgs (A5). Owner: v2 re-derivation, not
   this lane.
2. **Principal shape**: does v2 core keep a reserved `"org"` principal kind as
   a seam for Cloud, or go user-only with Cloud reintroducing it? Decide at
   contract time.
3. **Format, streaming, generation pipeline**: everything in A2/A3 is replaced
   by the format-gen-v2 lane's design; this list only guarantees the old
   machinery is not carried forward.
4. **Away-approval semantics** (B5) interact with automations' v2 contract;
   carry the "behavior stays, internals shrink" decision into that rewrite.

## Net effect

Roughly 7–9k of ~39k non-test source lines removed or halved. Every
code-parsing regex in the repo replaced by a real parser or an init question.
The two hairiest cross-cutting threads (sandbox lifecycle, store overlay)
reduced to single code paths. The only Cloud-residency violation (orgs)
excised to the side of the fence it belongs on.
