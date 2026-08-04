# Deep review: embedded-agent architecture spec

**2026-07-30.** Six parallel deep-dives against
`2026-07-30-embedded-agent-architecture-design.md`: two full code reads of
`rebuild/cutover`, an architecture stress-test, a DX review (api-design-dx +
vendo-dx bar), a competitive-landscape + buy-vs-build sweep, and an
industry-best-practice sweep. This file is the synthesis; nothing here
re-litigates the settled shape (dividing line, harness contract, packs,
Google-Docs permissions, naming).

## Verdict

The shape is right and, in five of six hard areas, at or ahead of published
industry practice. The guard/authority half of the design has **no competitor
anywhere** — it is the moat. The flaws found are all *inside* the chosen shape:
three are build-blocking (must be decided before the first `claudeCode()` or
`run_code` lane), several are spec-text contradictions the build would trip
over, and the reuse claim ("only 3 new subsystems") undercounts by roughly
half.

---

## 1. Build-blocking flaws (decide before building)

### F1 — Park-and-resume is not implementable as written for spawned-CLI harnesses

Multiple dives converged here (stress-test C1, best-practice §2, DX A0).
"Guarded call returns `pending-approval`; the harness returns; the runtime
resumes next turn" is a clean generator suspend in-process — and it is
**already how Vendo works today, in four shipping venues** (chat thread,
apps runtime, BYO approvals, automations; all on `guard.onApprovalDecision`,
`packages/guard/src/guard.ts:326`). The gap is specifically Claude Code /
Codex: there is no native primitive for "process exits now, tool result
injected days later." The session JSONL ends with a dangling `tool_use`;
`resume` replays, it does not accept an external tool result.

The naive fallback — model re-issues the call next turn — breaks the guard's
exact-input replay match (approval pinned to arg hash + descriptorHash,
`guard.ts:892-903`): slightly different args → re-ask ping-pong, or pressure
to loosen the match to tool-name-only, which quietly abandons "the approval
shows the real inputs."

**Fix (consistent with settled shape):** specify park per dialect.
- *Present user:* hold the MCP call open, block until decision (no park).
- *Away/timeout:* return a structured `pending-approval` tool result, end the
  turn; on resume **the runtime — not the model — replays the approved call**
  through the guard (the approval row already stores exact inputs), then opens
  the next turn with "your parked call X returned Y." Clear `turn.state` and
  re-seed for the dangling-`tool_use` case.
- Contract ergonomics (DX): `turn.tools.call()` always resolves to a readable
  tool result — `{status: "ok"|"denied"|"pending", ...}` — so a naive harness
  author who treats all three as the tool's answer is automatically correct.
  That makes "approval flow works in harnesses that never heard of it"
  literally true instead of aspirational.
- Best-practice note: re-evaluate a parked approval against **live**
  policy/grants at execution time, not park time (the spec already has this
  instinct for file commits; state it for approvals).
- Claude Code's native seam is the four-value permission vocabulary
  (allow/deny/**defer**/ask) — `defer` is the park hook.

### F2 — run_code / sandbox security: the declaration grant is too wide, egress is unstated, and the code today contradicts the spec

Three findings that are one story (stress-test C3, best-practice §3, guard
code-read gap #1):

1. **The declaration grant regresses the core invariant.** Today an approval
   shows the real inputs at the moment of the call. The bridge replaces that
   with approving a *name* ("this script may call `host_payments_send`") —
   arbitrary args, arbitrary many times, for the run — and the code that runs
   is model-written *after* the approval (that's the TOCTOU). "Provenance
   gates" are named but undefined and currently carry the whole security load.
   **Fix:** declarations for mutating tools carry *scopes* — pinned/constrained
   args (payee X, ≤ $N, ≤ k calls) rendered on the approval card, enforced
   per call by the bridge. This is the same "permission slip" shape §11.5
   sponsorship already assumes; make run_code use it. (Industry: this is
   CaMeL-lite — declaration handles control flow, argument-inspecting gates
   handle data flow; the pattern is sound *with* scopes.)
2. **Box egress is the missing third leg of the lethal trifecta.** The box
   holds host data (materialized workspace) and runs model-written code
   steerable by injected host content. If the sandbox has open internet
   (E2B's default), injected code exfiltrates the workspace with zero guard
   involvement — exfiltration isn't a tool call. `serve` mentions egress
   approvals; `run_code` says nothing. **Fix, one sentence with teeth:**
   *run_code boxes get no egress except the bridge*; anything else is a
   declared allowlist reusing the existing egress-approval machinery
   (`packages/apps/src/egress-approval.ts` — which is already the right
   shape: declared domains are an ask, not an authority). Anthropic's own
   sandbox-runtime ships a network-filtering proxy; default-deny is the
   emerging standard. This also constrains the sandbox adapter interface —
   the adapter must expose egress policy.
3. **The code today does the opposite of §9.** "Credentials never enter the
   box" is contradicted by `packages/apps/src/box-env.ts:50-76`: real secret
   values plus `VENDO_INFERENCE_KEY` injected as plain env vars — the
   inference key **unconditionally, with no approval** — into a box whose
   agent runs `permissionMode: "bypassPermissions"` with Bash
   (`packages/apps/box/agent-sdk.mjs:95-101`). A prompt-injected box agent can
   read and spend the inference key or use the always-allowed inference host
   as a covert channel. This was a deliberate v0 reversal (real values +
   provider-layer domain allowlist instead of the ENG-345 handle model), and
   reverting breaks the generated-server secrets story — so the spec and the
   code need a *decided* reconciliation, not a silent assumption. Related
   live issues from the same read: the box's mutating calls **already park
   mid-run with nobody to approve** (`wire/box.ts:254-260` mints
   presence:"away") — the exact friction the bridge is designed to remove,
   live today, not hypothetical; the box control port carries no bearer
   (security = unguessable hostname); `VENDO_APP_TOKEN` is long-lived
   full-owner-authority, not turn-scoped; and the constant per-app
   `sessionId` makes `duration:"session"` grants effectively standing.

### F3 — Mid-turn file sync is both required and forbidden; no crash/idempotency story

(Stress-test C2.) §6's headline UX — "skeleton on screen as soon as the plan
file exists" — requires a mid-turn file push; §9 says files sync at turn/job
end; §8 says the UI streams from the wire. For a bash-native builder the plan
file is written inside the box by a subagent's shell — not a yield — so the
skeleton renders only after the whole multi-minute turn, on exactly the
harness the spec introduces.

Same fault line: a harness dying mid-turn leaves audited host mutations, a
transcript with no trace of the turn, a native session that has it, and
streamed text the user saw that vanished on reload. Retrying re-executes
mutations; nothing in the spec is idempotent.

**Fix:** (1) designated hot paths sync mid-turn — the bridge watches the
app/plan file (the `vendo validate` shim doubles as a sync point); O(files
changed) is preserved. (2) A turn journal: one `turn-started` row before
dispatch; guarded mutating calls carry `(turnId, callSeq)` idempotency keys;
resume policy = never silently re-run a turn containing audited mutations.
Name the invariant: **audit trail ⊇ transcript, always; reconciliation runs
from the audit side.**

---

## 2. High-severity gaps (fix in the spec before the relevant lane)

### F4 — Concurrent commit to a shared org app is last-write-wins by omission

(Stress-test H2 + best-practice §5 agree.) Two editors — or user + sponsored
automation — both check out, both pass `can(editor)`, second commit clobbers
the first; and "the diff is the audit" computes against a stale base, so the
audit misrepresents what changed. **Fix:** per-file revision stamp at
checkout, compare-and-swap at commit (the store's `atomic` capability exists
and thread persist already uses this pattern). Stale base → a *conflict
outcome* surfaced to the harness (re-read, re-apply — resolving it is
thinking, correctly the harness's job). Agents are unusually good at
resolving their own conflicts when told "the file changed under you." LWW may
stand for `/user/`; for `/orgs/` it must not. No CRDTs.

### F5 — `turn.state` points into a machine the idle-TTL keeps destroying

(Stress-test H1 + best-practice §1.) Claude Code's session JSONL lives on the
box disk; every TTL expiry silently forces a full re-seed — and re-seed nukes
the prompt cache (documented: full cache_creation of 400-500k tokens on long
sessions) and loses the harness's co-trained compaction. Also, "cleared on
history edit → re-seed from our transcript" treats every edit as
from-scratch, when the dominant edit is truncate-and-retry — and the SDK has
native `resumeSessionAt` (rewind to message UUID) + `forkSession` that
preserve prefix cache. **Fix:** sync the session file out at turn end like a
workspace file (it's small) and re-materialize on acquire; rewind natively
for prefix truncations; clear-and-reseed only for arbitrary edits or harness
swaps; when re-seeding, seed compacted summary + recent turns, never the full
raw transcript. (The Claude Agent SDK now ships a `SessionStore` mirror
adapter that matches Vendo's canonical-transcript design exactly — the
vendor's own docs recommend owning the canonical copy and treating native
sessions as disposable. The design is right; the mechanics need these three
rules.)

### F6 — What the canonical transcript contains is undefined, and usage/cost has no channel

(Stress-test H5 + DX A1/A3.) For a spawned harness, mandated content =
narrative yields + guarded calls; 50 in-box bash/edit ops and three subagents
mirror as prose + a diff. Consequences: re-seed quality, a silent 3-minute
gap on the user's screen, and — worst — **token usage never crosses the
contract**, so metering/spend attribution for exactly the expensive harnesses
is unbuildable. **Fix:** one table in §3 — per event class (narrative,
guarded call, in-box op, subagent lifecycle, usage): transcript row / audit
row / wire-only progress event / dropped. Close the yield vocabulary now
(text / thinking / status / error / usage) — a v2 addition breaks every
host's renderer. Note the write law's "~15 rows" is only true because in-box
calls don't mirror; say so.

### F7 — `automations()` cannot be built on the four slots as claimed

(Stress-test H4, confirmed by code read.) Triggers need ingestion (webhook,
tick/scheduler), run records need a wire+UI surface, sponsorship needs
parking hooks — tools/skills/checks/components cover none of it, and today's
`createAutomations` is exactly the privileged umbrella wiring §5 forbids.
**Fix at the claim level now** (pack internals stay deferred): triggers and
scheduling are *platform lifecycle* like `serve` — core runtime, with the
automations pack contributing tools/skills/checks over it. Rewrite §5's
sentence; third-party packs will want triggers too.

### F8 — Served apps: no per-request `can()`, no commit moment, deployer-snapshot data

(Stress-test H6.) A served org app is both a sandbox and a wire; §8 gives
them opposite rules. **Fix:** the registered URL is a wire door →
`can(viewer, app)` per request against live rows (one indexed lookup);
served processes get read-only workspace + records-through-tools for
anything per-user; file writes from a served app are a job with a commit;
the reviewer's rubric checks nothing private is baked into the snapshot
(files materialized under the deployer's grants are visible to every viewer).

### F9 — The packs `components` slot crosses a boundary the code deliberately enforces, and layering forbids both new homes

(Code map #7/#8 + DX P3.) `definePack({components: {X: {schema, render}}})`
puts client React inside a server-consumed value, but the catalog contract is
explicit that the server "MUST IGNORE" the component reference
(`packages/core/src/catalog.ts:29-37`) and entry names mirror a client-side
map 1:1. **Fix:** packs are isomorphic modules passed twice — the same import
to `createVendo({packs})` (server reads tools/checks/skills, ignores render)
and to `<VendoRoot packs>` (client mounts render). Must be import-safe on the
server (RSC) — a lint rule + a docs paragraph, or pack authors crash Next.js
builds on day one. Separately: `dependency-guard.mjs` allows only
`@vendoai/vendo` to see multiple blocks, so `@vendoai/harnesses` (needs
agent+apps) and `definePack`'s types (actions+apps+ui) are both illegal
today — the established fix is types-into-core (the `Guard`/`StoreAdapter`
pattern); decide it consciously in the spec.

### F10 — Pack namespacing contradicts plain-markdown skills

(DX P1.) If the model sees `compliance_reports_check_report` but the skill
body — projected by copy, not translation — says `check_report`, the model
follows instructions to a tool that doesn't exist. **Fix: no renaming.**
Names are global as authored; collisions fail at boot naming both packs
(the spec already has boot-conflict — that alone *is* the namespacing
story). This also keeps `vendo pack export` honest.

### F11 — Review-on-commit has no failure protocol and an unexamined bill

(Stress-test H3.) What does FAIL do? Block a user's explicit one-line edit
via a judgment rule, with the builder dead and nobody assigned? Loop
unbounded? Plus: fresh-subagent latency on every commit; reviewer test-drive
read-calls count against the *user's* guard breakers; judgment checks stack
per pack. **Fix:** FAIL → commit lands as a draft/flagged version (previous
version keeps serving — 06's invisible-graduation shape), one bounded fix
round, then surface honestly. Depth scales with blast radius by default
(org-shared/automation apps → full test-drive; personal quick edits →
rubric-only). Reviewer traffic gets its own breaker context key. Industry
enrichment (Cognition): reviewer pre-commits expected behavior before
test-driving, and emits evidence artifacts (screenshots/recordings), not
just a verdict — the audit trail wants them anyway.

---

## 3. The reuse claim, corrected

> "lots of existing code transplants, only 3 new subsystems"

Half right. What's genuinely near-free (and partly undersold):

- **Guard, policy channel, judgments ratchet, breakers, grants, audit** —
  trivial. One real choke point verified in composition
  (`server.ts:1577`, every consumer gets the same `boundTools`). The
  one-way judgment ratchet (loosenings queue for a human, hardenings apply)
  is stronger than the spec advertises.
- **Park-and-resume** — trivial; already ships in four venues.
- **Tool projection** — trivial; six dialects already ship, including an
  in-process MCP server into a Claude Agent SDK session (`box/agent-sdk.mjs`)
  and a proven `canUseTool` hook (`engine/sdk-seam.ts:201`) — never
  guard-wired, but the mechanism is in-house.
- **`vendo_tools_search` with live mid-turn materialization** — the spec's
  hard part of `find_tools` already works.
- **Extraction (~5,700 lines), generation pipeline mechanics, checks floor,
  adapter-rule composition** — trivial-to-moderate.

What the spec names as new: harness contract (moderate shell, big-lift
contents), workspace façade (moderate), packs (big lift).

What it doesn't count, and has **zero code**: skills (a subsystem, not a
slot) · `can()` + org rows + promote (org tables were *deliberately deleted*
under kill-list §A5 — this is re-adding a cut subsystem) · subagent hiring ·
steering · `turn.state` persistence/invalidation · `sandbox.acquire(workspace)`
+ materialize/sync (today's machines are per-app, not per-session) ·
`run_code`/`serve`/`ask_user`/`validate`/`schedule`/`search_components`/
`records_*` as tools · `files` adapter · `vendo pack export`.

**Honest count: ~5 real new subsystems plus one store schema migration.**

The schema migration: the O(messages) write law contradicts today's storage —
one `vendo_threads` row holding the whole transcript, rewritten wholesale
every turn (`threads.ts:171`). O(1) rows but O(thread) bytes — which is what
"never O(tokens)" forbids. Message-level rows = new table, new read path,
new CAS story, against a frozen public contract (`02-store.md` §2).

Smaller spec-text corrections surfaced by the code read:
- The choke point is two rings: `connectGate.bind(guard.bind(actions))` —
  the connect gate short-circuits *before* the guard with its own audit
  event. Fine, but "one guard" is a simplification of "gate ∘ guard".
- The MCP door's ride-along `vendo_apps_*` path hand-rolls
  check→execute→report (`door.ts:527`) — a divergence risk to fold into
  `bind()` during the build.
- Today's harness is not permission-blind: `createAgent` takes the raw guard
  for `previewCheck`/`directions`; the contract deletes `previewCheck`
  (good — a simplification, but it removes the AI SDK's native pause and
  must be replaced by the F1 outcome shape).
- Approving is two independent writes today (SDK part flip + POST decide);
  fail-closed but a silent re-ask if only one lands — `turn.tools` should
  own both as one transition.
- Descriptors are JSON Schema + registry-level dispatch (frozen convention,
  descriptorHash built on it); the spec says "zod input" + per-tool
  `execute` — additive, but needs a hash-stability story.
- `tools:` is not a config key today (arrives via `.vendo/` profile); §10's
  "six slots" leaves ~20 of today's 29 keys unaccounted for — every one
  needs a stated destination (fold connectors into tools; catalog into
  `apps()`; policy+judge stay a named `guard:` area; instructions top-level;
  the rest mapped or deleted in a migration table).
- `@vendoai/engine` name collision: it's the npx extraction runner, not
  "today's engine" (= `packages/apps/src/generation`).
- Audit is best-effort in several places (swallowed `report()` failures,
  post-stream persist can fail after delivery) — fine individually,
  but "the diff is the audit entry" needs the F3 invariant.
- Guard breakers are per-process in-memory — multi-instance deploys get N×
  the budget.

## 4. DX findings not covered above

(Full detail in the DX dive; top items.)

- **One-key day-one.** `tools: hostTools` has no visible origin. Keep
  init-first: `vendo init` writes `.vendo/`, `createVendo({auth})` reads it
  by default; `tools:` becomes the rung-2 override. The quickstart is one
  key + one CLI command.
- **One place for the loop's model.** `harness: claudeCode({model})` and
  `models.default` both exist in §10 — today's `model` vs `models.agent`
  deprecation dance rebuilt on day one. Harnesses read their seat
  (`turn.models.default`, resolved: seat → ladder → gateway); setting both
  is a boot error. Also: closed, typed seat map (default/reviewer/judge/fill).
- **`files` is a documented default, not a decision.** Unset → blobs in the
  store up to a cap; first over-cap write fails with the exact fix. Demote
  to rung 3.
- **Typed host tools via codegen.** `vendo sync` emits `.vendo/tools.d.ts`
  (declaration merging) so host-authored code gets typed names+args — the
  Prisma/Auth.js trick; sync already has the data.
- **Errors:** model-credential failure must surface *in the chat surface*
  with the three fixes; `auth` resolving null on a cookie-bearing request
  logs a dev warning (silent-anonymous is the ship-it-broken trap);
  `cloud-required` degrades the *surface* (no live-looking Share button
  that throws).
- **Check authoring contract:** fact checks pure/instant returning
  `Finding {severity: block|warn}`; judgment rules join the reviewer rubric;
  floor is order-independent AND — one sentence closes cross-pack ordering.
- Naming: spec uses both `find_tools` and `search_tools` — fix; pair it as
  `find_tools`/`find_components`. "Harness" needs its first-sentence
  definition everywhere (test-harness prior; and it's now Vercel-marketed
  vocabulary — see §5).

## 5. Landscape (mid-2026)

**The harness abstraction is no longer unique — the guard half is.**
Vercel AI SDK 7 shipped `HarnessAgent` in canary (June 12, 2026): one API
over Claude Code, Codex, Pi (+ DeepAgents, OpenCode adapters in-repo),
sandboxed workspaces, swap-like-a-model. Experimental, MIT. It has **no
permission hooks, no approval flow, no per-end-user identity, no canonical
transcript, no checks floor** — it validates the §3 bet while proving the
authority half is uncontested. Worth an internal look at wrapping their
adapter packages for Codex/OpenCode spawn plumbing; the guard/MCP-projection
work is ours either way. Cloudflare platformizes harnesses (Project Think,
Flue-on-Pi) but doesn't abstract across them. Anthropic Managed Agents added
self-hosted sandboxes + MCP tunnels (May 2026) — exactly the callback
dialect's shape; strengthens the `managedAgents()` fast-follow.

**GigaCatalyst drifted off the lane** — now leads with vendor-side demo/POC
automation from call transcripts (overlaps our demo-creator more than the
embedded layer). Watch: their pivot is market signal that the first payer
may be the vendor's GTM team. **CopilotKit raised $27M** (May 2026) — owns
transport + React surface (AG-UI adopted by Google/Microsoft/Amazon/
LangChain), not authority/extraction/checks/workspace. Thesys C1, Tambo,
json-render: schema-constrained generated UI is now commodity — the
differentiators left are the checks floor, per-user data binding through
guarded tools, and edit-like-a-file persistence.

**Standards bets confirmed.** SKILL.md became an open standard (Dec 2025,
agentskills.io, Agentic AI Foundation) with ~40 adopters by June 2026
including OpenAI Codex — pack skills as SKILL.md-on-disk is exactly right.
MCP Apps ratified 2026-01-26; OpenAI's Apps SDK now layers on it. One stale
spec sentence: "components have no downstream equivalent" — MCP Apps now
carries declared UI, so components have a plausible *degraded* fourth export
target; the checks half remains truly export-less. Reword so the
differentiation claim stays precise.

**Novelty scorecard (honest):**
- *Genuinely novel, nobody found doing it:* per-end-user guard with
  grants-as-approval + descriptorHash binding; sponsorship; the run_code↔guard
  bridge; the harness-independent checks floor; packs with checks+components
  slots; workspace-as-store-façade with can() at checkout/commit + mid-session
  harness swap over a canonical transcript.
- *Convergent (validation, not moat):* harness abstraction, schema-constrained
  generative UI, SKILL.md skills, agent↔UI protocols, embedded-builder-over-
  host-API.
- *Commodity (never build):* sandboxes, connector catalogs, chat-surface
  primitives, observability backends, model gateways.

## 6. Buy / use / build

| Subsystem | Call | Notes |
|---|---|---|
| Sandboxes | **BUY** (already the plan) | E2B first (pause/resume maps onto idle-TTL; paused ≈ free). Cloudflare Sandboxes GA (Apr 2026) = the natural Cloud adapter (scale-to-zero, URL exposure = `serve`, DO facets). Daytona/Fly Sprites as third adapters. Adapter must expose egress policy (F2). |
| Authorization (`can()`) | **BUILD** | Closed 3-level vocabulary over indexed rows = a few hundred lines; SpiceDB/OpenFGA are separate services with their own datastore — a BYO violation. Revisit only if recursion arrives (folder hierarchies, cascading roles); steal OpenFGA's modeling language then, not the engine. |
| Durable execution | **BUILD park; WATCH Restate for automations** | Park-as-turn-outcome designed the hard problem away — resume state is rows; Temporal-class replay solves a problem we don't have. OSS automations = scheduler over store rows; Cloud adapter on Workflows/DO; Restate (single binary) is the BYO-shaped engine if host demand appears. Never Temporal. |
| Approvals / HITL | **BUILD** | It's the product. HumanLayer/gotoHuman are external channel-routers — a third party in the authority path. Use native hooks as projections (Claude SDK canUseTool/defer; OpenAI interruptions-as-return-value validates the park model). |
| Connectors | **KEEP BUYING (Composio) + adapter seam pre-GA** | Arcade for per-user delegated OAuth governance; Nango for code-first tool definitions in the host's repo (philosophically closest). Never build a catalog. |
| Audit vs observability | **BUILD audit; EMIT OTel GenAI** | Audit is authority data in the host's store — no vendor stores it correctly. Ship an optional OTel GenAI exporter (pin the convention version; attrs still "Development" stability); recommend Langfuse as the self-hostable default. Never build dashboards. |

## 7. What's genuinely excellent (keep, and say louder)

1. **The three-owner state table** — the load-bearing idea; it's what makes
   harness swap, audit, and BYO-thinking real. The vendor ecosystem
   converged on the same answer (SDK SessionStore; OpenAI's opposite bet
   shows why the durable copy should be yours).
2. **Safe by construction through one choke point** — verified real in
   composition today; a harness author cannot forget the safety story.
   Nobody else has it, including Vercel's HarnessAgent.
3. **The hands table** — refusing to confiscate bash from bash-native
   harnesses; asymmetry-honest where most designs go false-uniform.
4. **Park as an outcome** — the strongest published version of the pattern
   (with F1's ergonomics); run_code's authority-before-execution is ahead of
   the field (with F2's scopes).
5. **Sponsor/adopt** — the whole 2am-authority story in two human verbs and
   an honest card label.
6. **Packs export downward** — author rich, project to the (now-confirmed-
   standard) poor formats; the rich half (checks + guarded components) has
   no equivalent anywhere.
7. **The 6-slot collapse + boot-time composition errors as law** — the right
   surface, once the 29→6 migration map exists.
8. **The one-way judgment ratchet** (in code, unadvertised) — model-authored
   policy may only tighten; loosenings queue for a human. Put it in the spec;
   it's a differentiator.

## 8. Recommended spec amendments (one pass, ~10 edits)

1. §3: park per dialect + `{ok|denied|pending}` call outcome + runtime-replays-
   approved-call on resume (F1).
2. §3: the mirroring table (event class → transcript/audit/wire/dropped) +
   closed yield vocabulary + usage channel (F6).
3. §3: `turn.state` for spawned harnesses = session id + synced session file;
   native rewind before re-seed (F5).
4. §9: run_code declarations carry scopes; box egress = bridge-only +
   declared allowlist; define or delete "provenance gates"; reconcile §9
   with box-env reality — decide handles vs. scoped real values, and gate
   the inference key (F2).
5. §8/§9: turn journal + idempotency keys + audit ⊇ transcript invariant;
   designated hot-path mid-turn sync (F3).
6. §8: per-file CAS at commit for `/orgs/`; conflict is a tool outcome (F4).
7. §8: served apps = wire door, per-request can(), read-only workspace (F8).
8. §7: review failure protocol (draft/flagged version, one bounded fix round,
   blast-radius depth default, reviewer breaker context) (F11).
9. §5: triggers are platform lifecycle; rewrite the automations claim (F7);
   packs are isomorphic modules passed twice (F9); no tool renaming —
   boot-collision IS the namespacing (F10); pack renames invalidate grants
   same as host renames.
10. §10: the 29→6 migration table; `tools` via init by default; one model
    resolution order; `files` as documented default; MCP-Apps sentence
    correction; `find_tools`/`search_tools` consistency; note the layering
    decision (types into core) and the two-ring choke point.
