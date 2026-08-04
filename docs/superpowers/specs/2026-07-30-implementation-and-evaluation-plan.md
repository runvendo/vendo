# Implementation & evaluation plan

**2026-07-30.** Third of three documents. Read in this order:

1. `2026-07-30-embedded-agent-architecture-design.md` — the architecture (why + laws)
2. `2026-07-30-build-contract.md` — exact shapes (frozen; do not diverge)
3. this file — what gets built, in what order, and how it is proven

## 0. START HERE (orchestrator brief)

You are taking over a build whose design is finished. Read the three documents,
then run wave 1. What you need to know about the state of things:

- **Nothing is built yet.** The three docs are the entire output so far. Branch
  `rebuild/cutover`; last spec commit `9a1b72991`.
- **Nothing builds without Yousef's go**, per the factory rule. Confirm before
  dispatch.
- **The design survived four adversarial reviews** (findings in
  `2026-07-30-embedded-agent-architecture-review.md`, all folded or explicitly
  deferred). Re-litigating settled decisions wastes his time — check the review
  file and the memory note `vendo-embedded-agent-architecture` first.
- **Most of the product already exists.** Guard, generation machinery, store,
  automations, MCP door, e2b adapter, checks layer, the edit dialect: all
  transplant. The genuinely new subsystems are four, listed below.
- **The one rule to hold**: *we own state, tools, checks, guard, skills; the
  harness owns thinking, and orchestration is thinking.* Yousef rejected three
  designs for violating it. Test every proposal against it.
- Two things stay open by decision, not omission: the box-secrets
  reconciliation, and the display/remix design pass (mockups, his taste).
- **Seam ownership**: exactly one owner for changes to the build contract —
  you. A lane that needs a shape changed asks; it never diverges locally.

## 1. What is actually new

| New subsystem | Where it lands | Leans on |
|---|---|---|
| Harness contract + runtime | `@vendoai/harnesses` (new), types in core | today's agent loop, the six shipped tool projections |
| Workspace façade | `@vendoai/store` + core types | store records/blobs, just-bash `IFileSystem`, `app-data.ts` pattern |
| Packs + skills | core types + umbrella wiring | registry `add()`, the catalog, the shipped `Check` layer |
| Consent hardening | `@vendoai/guard` | grant sets, approvals, audit — all shipped |

Everything else in the waves is reshaping or projection.

## 2. Wave 1 — foundations (4 lanes, parallel)

Seams freeze here. All four lanes build against §1–§7 of the build contract.

### Lane A — harness contract + `vendo()`
Build: core contract types · the `@vendoai/harnesses` runtime (Turn assembly,
event routing per the frozen table, transcript persistence, the existing
`data-vendo-*` wire stream, mirroring of tool calls) · `vendo()` = today's
`@vendoai/agent` loop lifted out of its stream closure onto `run(turn)`, plus
subagent hiring · `defineHarness` · boot-time composition errors.
Out of scope: steering, `claudeCode()`, config consolidation.
Proven by: E1, E2, E6.

### Lane B — workspace
Build: the two tables (contract §3.3) · the `IFileSystem` implementation over
the store with the turn-start path index · `/user` + `/host` mounts · commit +
history/undo · the `FilesAdapter` seam and `s3()` · erase-cascade and
subject-adoption wiring.
Out of scope: `/orgs`, `can()` beyond ownership, materialization (lane E).
Proven by: E3, E6.

### Lane C — packs + skills
Build: `definePack` and the four slots · boot merge + collision errors · the
skills store, `/host/skills` mounting, and per-harness projection (SKILL.md
copy, no translation) · `apps()` and `automations()` re-expressed on the public
interface · the checks floor extracted from generation into a host-pluggable
layer (contract §5's `Check`) · the building-apps skill authored from today's
prompt sections.
Out of scope: `pack export`, triggers-as-pack-content (platform lifecycle stays
core).
Proven by: E4, E5.

### Lane D — tools, consent, store migration
Build: `ask_user` (question card + the one door; extend the client-upsert gate
deliberately and get it security-reviewed) · `validate`, `search_components`,
`records_*` as projected tools · `find_tools` rename · host product-slug
prefixes · the seat map (contract §4) with `models.reviewer` · review-on-commit
(fresh subagent + failure protocol) · grant-set `intentHash` · the effect
ledger · `title` into `descriptorHash` · the one-row-per-message migration
(contract §6) · the hosted-anon-sessions 404 fix.
Out of scope: conditions, scope constraints, org policy.
Proven by: E2, E4, E5, E7.

## 3. Wave 2 — the flagship (needs A + B, C for skills)

- **Lane E — `claudeCode()`**: sandbox spawn + workspace materialization and
  diff sync-back · in-process MCP projection of the guarded toolset · guard asks
  delivered through the native permission hook · session-file sync + native
  rewind · SDK in the sandbox image · `machine: "local"`.
- **Lane F — `instant()` + surface**: extract the conductor behind the contract ·
  publish `@vendoai/harnesses` · consolidate `createVendo` config to the six
  slots + `packs` with the 29→6 migration table · init-first quickstart.

Proven by: E1 (the headline test), E3, E6, E7.

## 4. Wave 3 — multi-party (Cloud; needs B)

- **Lane G — orgs + `can()`** (AMENDED 2026-08-01, decisions LOCKED with
  Yousef — see design spec §8): NO membership rows, ever — the host's
  identity system IS the org, asserted by a `memberships` callback on the
  auth preset (callable for unattended runs too; kill-list §A5 stays
  honored). Vendo stores only per-app grants (viewer/editor/owner) ·
  `can()` as one function called by façade, wire, and MCP door · `/orgs`
  mounts with CAS commits · promote + `forkedFrom` · per-request `can()`
  for served apps · console = hosted-tier org management only, plus an
  optional read-only observed view for BYO; no console channel into a
  host's database.
- **Lane H — sponsorship + org policy**: sponsor field · adopt on departure
  *and* on third-party edit · window labels · the org-admin policy layer
  (tighten-only).

Proven by: E8.

## 5. Parallel tracks (never on the critical path)

Display & remix design pass (launcher, pins; mockups first, his taste) ·
benches (§7 breadth) · parked brainstorms (box secrets, automations-pack detail).

## 6. Evaluation — done means proven by running the real thing

Real services, real browser, Yousef's Vendo Cloud account. No lane reports
green on tests alone.

### E1 — The harness-swap proof (the headline)
The architecture's central claim, proven with **one of each thing, not a
corpus** — five asks, run on `vendo()`, `instant()`, and `claudeCode()`:

1. a normal app (reads host data, renders)
2. an edit to that app ("make it blue" → in-place, identity preserved)
3. an automation (enable → fires → writes → visible in run history)
4. an action through an external connector (connect flow → guarded call)
5. an impossible ask (honest refusal, no invention)

Pass: each works on each harness; **guard decisions and audit rows are identical
across harnesses** for the same ask; swapping the harness mid-conversation
continues the thread from our transcript. Breadth comes later (§7) — this is
"does the machine work", not "how good is it".

### E2 — Consent, in a browser
Screenshots required. (a) First app: reads only → zero cards; the skeleton
renders. (b) An app that writes → one pre-filled card, one tap, then silence on
subsequent runs. (c) Interactive destructive action → popup with the real amount
and recipient; approve → executes; refuse → honest message. (d) Automation
enable → one card. (e) **An automation attempting a destructive tool → refused,
with the prepare-then-send path offered.** (f) Missing grant, unattended → the
failure card appears on the app surface with a badge; grant → re-run succeeds.
(g) Edit the app's declared tools → re-ask covers only the delta.

### E3 — Workspace and materialization
Same app edited by `vendo()` (façade tools) and by `claudeCode()` (real bash in
a sandbox) → identical stored result. Kill a sandbox mid-turn → the store is
unchanged and the next turn recovers. Two concurrent commits to one `/orgs` file
→ one succeeds, the other gets a conflict outcome and resolves it. Undo walks
history. Over-cap file with no `files:` adapter → the error names the fix.

### E4 — The floor holds
A deliberately bad app (invented data, a payment tool used as a message
channel, a dead button) → validate + review catch it, the flagged-version
protocol runs, the owner-override path works, and a host check fires even when
the builder skipped self-review. (The recorded-incident replay — the condition
for retiring the shipped deterministic gates — is a §7 breadth run, after the
machine works.)

### E5 — Packs are real
A pack authored *outside* our repo (tools + skill + fact check + judgment rule +
component) installs with one config line and works end to end: its tool is
guarded, its skill loads on demand, its checks fire, its component renders.
Two packs claiming one tool name → boot error naming both.

### E6 — Regression gates (hard; from the v2 spec)
Failure rate never worse than today's baseline · latency never worse ·
real layout on screen ≤5s typical · `pnpm build && test && typecheck && lint`
green · transcript writes stay O(messages) (measured, not asserted).

### E7 — Safety properties
Re-run after a failed run never repeats a completed mutation (effect ledger) ·
a retitled tool invalidates its grants · an edited app invalidates its grant set
· no credential ever appears in a sandbox env dump *except* the recorded v0
exception · the audit trail is a superset of the transcript for every run.

### E8 — Multi-party (wave 3)
Two accounts: promote → both see one living app · viewer can't edit and is
offered a fork · revoke mid-session (reads age, writes fail at commit) · an
org-shared app's per-user data stays separate · sponsor offboarded → adoption
card → adopted → runs continue · a third party edits a sponsored app →
sponsorship invalidated.

## 7. Breadth, after it works

Only once E1–E7 pass. These measure and tune; they never gate a lane:

- the full ask corpus across harnesses (failure rate, latency distribution)
- the recorded-incident replay — retires the shipped deterministic gates
- benches: `vendo()` vs `claudeCode()`+skill on simple asks (time-to-skeleton,
  cost, failure rate) → sets the default harness · reviewer depth dial · fill
  worker weight/tier/concurrency

## 8. Lane discipline

Each lane gets one handoff contract naming: its build list, the frozen shapes it
consumes, its acceptance items from §6, its out-of-scope list, and the files it
owns. Rules: one worktree per lane · no lane edits another's files · seam
questions go to the orchestrator, never resolved locally · a lane reports the
moment it finishes · verification is independent (never the builder's own
claim).
