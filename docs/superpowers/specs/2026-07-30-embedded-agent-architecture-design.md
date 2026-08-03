# Vendo — the embedded agent layer

**2026-07-30.** The final architecture, designed with Yousef; brainstorm ongoing —
the items in §16 are still open. Nothing builds before his go.

## 1. The mission

Vendo is the embedded agent layer: if a company wants an agent inside its product,
Vendo is the stop for it. We own the in-product surface, the host's tools
(extraction), per-end-user authority (guard), verification (checks), and
persistence. Who thinks is a swappable adapter, like the store and the sandbox.

## 2. The dividing line

> **We own state, tools, checks, guard, and skills. The harness owns thinking —
> and orchestration is thinking.**

Subagents, parallelism, delegation, context management, when-to-go-deep: all the
harness's business. We never build orchestration; we build the façades the harness
thinks with, and the gates that hold regardless of who thinks.

Two kinds of moving part, nothing else:

- **Agents** — everything that exercises judgment, at whatever weight the hiring
  context chooses. All through one contract (§3).
- **Functions and gates** — everything that doesn't: validate, guard policy,
  audit, and *when checks fire*. Plain code.

Single model calls survive only as private internals: `instant()`'s guts,
the guard judge (hot path), and mechanical utilities (compaction summaries,
titles).

## 3. The harness

The harness is the embeddable agent — lean, app-ignorant, one thinker per
conversation. It discovers capabilities (packs) at runtime and hires its own
staff to execute them. The user always sees one assistant; harnesses, subagents,
and checks have no face.

One central home: `@vendoai/harnesses` — built-ins at the root, external
drivers as subpaths with their SDKs as optional peers
(`@vendoai/harnesses/claude-code`).

- **v1:** `vendo()` (default, in-process, key-free — today's `@vendoai/agent`
  reshaped onto the contract, gaining workspace+skills, subagent hiring, and
  steering) · `instant()` (the non-agentic ≤5s specialist, authored in apps
  and re-exported here) · `claudeCode()` (new; Agent SDK;
  proves session sandbox, `turn.state`, MCP projection, native permission
  hook).
- **Fast-follow, in order:** `codex()` (reuses the spawned-CLI path) ·
  `pi()` (premium in-process alternative; the contract's honesty check and
  vendo()'s bench rival) · `managedAgents()` (proves the callback dialect) ·
  `opencode()` demand-driven · hosts' own via `defineHarness` from day one.
- vendo() is built on our existing runner + AI SDK — never on Pi (transcript/
  schema friction at the core, 0.x foundation risk); Pi's steering queues,
  event granularity, and non-destructive compaction are borrowed as design.
- **claudeCode() specifics (settled):** its own permission system is
  repurposed, not trusted — auto-allow inside the box (the box is the
  permission: copies only, no credentials; reality happens at commit), and
  our guard's asks are delivered through its native permission hook so the
  co-trained pause-and-explain behavior serves our cards. The ~250MB Agent
  SDK ships inside the sandbox image, never in the host's node_modules —
  `@vendoai/harnesses/claude-code` is a thin spawner. v1 options: `model`,
  `effort`, `maxTurns`, `machine: "local"`; nothing else until asked.

### The contract

```ts
export const acmeHarness = defineHarness({
  name: "acme-loop",
  options: z.object({ model: z.string().default("claude-fable-5") }),
  async *run(turn) {
    // turn.messages  conversation so far — ours, canonical, read-only
    // turn.tools     everything projected; call() is guarded + audited
    //                + mirrored automatically
    // turn.skills    pack skills — listed cheap, load(name) for full text
    // turn.state     the harness's own persisted state — opaque to us
    // turn.options   resolved knobs, incl. per-turn overrides
    // turn.models   the resolved model seats (§10)
    // turn.signal    abort
    yield { type: "text", delta: "…" };   // closed vocabulary, §3 mirroring
  },
});
```

- **Tool calls are safe by construction.** Calls through `turn.tools` pass the
  guard, land in the audit trail, and mirror into the transcript — a harness
  author cannot forget the safety story.
- **Approvals wait or fail — they never suspend a run.** **She acted** (a
  click, a message, a submit — the action itself is the proof she's there):
  the guarded call blocks and a popup appears in the flow, exactly like any
  confirm dialog; she taps, the call continues. **Nobody acted** (an
  automation, a background run): no popup is possible, so the run **fails
  loudly** with an actionable card ("needs approval for X — Grant &
  re-run"); the grant persists, and re-run is a *fresh run against live data*
  — nothing is replayed. Two guards on the waiting case, no doctrine: a short
  timeout (≤90s, for the closed-tab case) and no sandbox lease held while
  waiting. Park/suspend is never extended to new surfaces (the automations
  engine's shipped internal step-resume stays as an implementation detail).
- **Failure cards have a home**: the app's own surface. One card per missing
  grant per app.
  **NOT BUILT (audited 2026-07-31, was aspirational):** the launcher badge
  count does not exist (`vendo-overlay.tsx` renders an icon and a label, no
  count, no data hook); the skipped-run count has nowhere to live
  (`ApprovalRequest` has no counter field); the host notification hook does not
  exist. And the dedupe holds only at ENABLE time
  (`automations/engine.ts` per `(appId, tool)`) — on the FIRE path
  `#parkApproval` mints a fresh id with no lookup, so N failed firings leave N
  standing cards, the opposite of the intent. Each is a follow-up lane, not a
  wave-1 claim.
- **Re-runs are safe because effects are ledgered.** Every executed guarded
  mutating call writes an idempotency key (run/turn id + tool + exact input
  hash) beside its audit row; on re-run, a call whose key already succeeded
  returns the recorded outcome instead of executing. Duplicate records are
  ugly even when they aren't dangerous — the ledger is what makes
  fail-and-re-run correct everywhere.
- **Options are declared, then overridable per turn.** Adapters declare their
  knobs (typed schema); hosts forward what they choose to end users (model
  picker etc.); the wire forwards nothing by default. Host-side dependencies
  (loggers, flags) arrive by factory closure — `acmeHarness({ logger })` — no
  context slot.
- **Two doors into the guard, one guard.** In-process harnesses call
  `turn.tools`; spawned harnesses get their native dialect and every call
  still lands in the same choke point. Projections per harness: plain
  functions (ours, Pi, custom) · in-process MCP + native permission hook
  (Claude Code SDK — guard asks surface as its own permission flow) · MCP
  config (spawned CLIs) · callback events (Managed Agents).

### Harness state

Three-part state, three owners:

| State | What | Owner |
|---|---|---|
| Conversation | the transcript | Vendo store — canonical for render, audit, review, resume |
| Workspace | files, skills, memory, app source | Vendo store — survives across turns and harness swaps |
| Harness state | `turn.state` — e.g. a session id | the harness; opaque, persisted by us, disposable |

Session-owning harnesses (Claude Code, Codex) keep their native session via
`turn.state` and get their co-trained compaction/caching. The native session
file is treated as one more workspace file: synced out at turn end, re-
materialized on acquire — an idle-TTL'd sandbox never costs a re-seed. Prefix
truncations (retry an edited message) use the harness's native rewind; only
arbitrary history edits or a harness swap clear `turn.state`, and a re-seed
feeds a compact summary + recent turns, never the raw transcript. Correctness
never depends on the harness's copy; the truth is ours.

**Mirroring — what goes where.** Yield vocabulary is closed: `text · status ·
error · usage`. Routing: text → screen + transcript; status → screen only
(ephemeral); in-box bash/file ops → nowhere but the commit diff (audit);
subagents → one transcript receipt line, never the screen (one-assistant law);
guarded calls → transcript + audit rows; usage → audit/metering only.
Invariant (narrowed 2026-07-31 after the live proof, and now actually tested —
`packages/vendo/src/audit-superset.e2e.test.ts`): **audit ⊇ transcript for
accountable events** — every guarded call, approval, error, subagent hire and
token spend that reaches the transcript has an audit row, and the audit
additionally carries what the transcript never does (usage/metering, in-box
file ops). Prose is the story layer itself, not a member of the set: `text`
routes to screen + transcript and takes no audit row by design, so the
unqualified set claim was false as written. Billing and reconciliation never
depend on the story layer. One fact a naive reconciliation gets wrong: a
subagent's token spend rides its OWN audit row and is not folded into the
turn's usage total. The write law's "~15 rows/turn" holds because in-box ops
don't mirror.

**The consumer voice law.** The agent never talks about code, tools, or files
to an end user. Three anchors: surfaces render tool *titles and verbs*
("Checked your invoices"), never names — rendering-layer law; every skill and
prompt carries the register (plain language, no paths, no jargon); the
reviewer rubric makes user-visible technical jargon a finding. Errors follow
it too: plain-language, no internals. **Friendly is not vague:** the render
always carries the material arguments — "Sent $1,400 to Acme Utilities",
never "Sent a payment" — and an argument-free description of a mutating
action is a reviewer finding like jargon is. Consent surfaces carry the
§12 completeness carve-out; tool titles are unique per deployment (boot
error on collision) so two different actions can never read identically.

## 4. Tools

Defined once, neutral (`name / description / zod input / risk / execute`),
projected everywhere — every harness, the MCP door, `find_tools`. Execution is
always on our side; the guard wraps every harness identically.

Four families: **host** (extracted API, as the signed-in user) · **workspace**
(read/write/edit/ls/grep) · **vendo verbs** (`records_list/put/delete`,
`schedule`, `find_tools`, `search_components`, `validate`) · **ask_user**
(questions, one door, any seat).

There is deliberately **no code-execution tool**: bash-native harnesses run
code in their own sandbox, and machine-less harnesses have in-process bash over
the workspace (§8) plus computed values for math. Layer-3 served apps stay as
they ship today, not as a harness-facing tool.

Naming and projection law for the families:

- **Host tools carry the host's product slug as prefix** (`maple_invoices_list`),
  derived at init, configurable — never the word "host"; the model should read
  them as native product actions. Renames invalidate descriptorHash-bound
  grants, so this lands pre-GA or never. **Compound tools** (host-authored
  macros in overrides.json: a named sequence of enabled primitive steps,
  declared risk = riskiest step, every step re-enters the guard individually)
  are host-family members, documented as convenience-never-bypass.
- **`find_tools`** (renamed from vendo_tools_search): searches every
  descriptor including the curated-out long tail AND equips matches into the
  live toolset mid-turn. No separate search_connectors — results include
  unconnected connector tools annotated connect-required, feeding the
  existing connect-card flow.
- **`validate` is also projected into the sandbox as a CLI shim**
  (`vendo validate <file>` on the box PATH, calling back through the bridge)
  so bash-native harnesses use it in their natural edit-check-fix rhythm.
  Generic box-side linters (tsc/eslint on island TSX) are free extra signal,
  never a substitute — validate checks against our catalog and the host's
  schemas, which live on our side.

**Hands vary; the cabinet, the guard, and the checks never vary.** Every
harness can do file work — what differs is the hands it reaches the workspace
with:

| Harness | Hands | File work | Arbitrary code |
|---|---|---|---|
| bash-native (Claude Code, Codex) | a real shell; workspace materialized in the session sandbox | grep/sed/editor/python — the whole CLI long tail, co-training intact | native |
| in-process (vendo(), Pi-based, custom) | workspace tools + in-process bash (§8) | `edit(file, old, new)` | no |
| hosted (Managed Agents) | callbacks — tools execute our side | same, over a longer wire | no |

Bash beats workspace tools wherever a machine exists — wrapping a bash-native
harness in `workspace_*` tools would confiscate the hands we chose it for.
Bash edits sync back to the store (the diff is the audit entry); tool edits
hit the store directly — next turn, a different harness sees the identical
workspace. A machine-less harness with no sandbox and no computed-value fit
takes the honest cannot-path. **Authority is always tools, every harness**:
host calls, records, ask_user need the user's identity and the guard, and
the sandbox holds no credentials — there is no file to bash. Hand-quality
changes what a harness can do to files, never what it can do to the world.

Curation: a small top-level list; the long tail reachable via `find_tools`.

**Documents are files; records are tables.** App source, memory, skills,
uploads, generated reports — file-shaped, in the workspace. Data rows —
table-shaped, subject-partitioned, reached through tools, never `cat`.

## 5. Packs

Capability arrives as a pack: a plain value contributing to slots that already
exist. Nothing else extends Vendo; the architecture's own joints are the plugin
system.

```ts
export const complianceReports = definePack({
  name: "compliance-reports",
  tools: [checkReportTool],
  skills: [{ name: "building-compliance-reports", body: skillMd }],
  checks: [{ kind: "fact", run: findUnmaskedAccounts },
           { kind: "judgment", rule: "Totals must cite their query." }],
  components: { RetentionBadge: { schema, render } },
});
```

- Four slots, no more: tools → the one registry (guarded, projected); skills →
  workspace mounts, projected per harness layout (on-disk format =
  agentskills.io SKILL.md — Pi and Claude Code read it natively, so projection
  is a copy, not a translation); checks → the floor; components → the catalog.
  Packs needing rows use the existing records machinery.
- Packs contribute to existing slots **only** — no config surface, no guard
  wrapping, no reaching into other packs.
- `apps()` and `automations()` are built on this exact interface — no
  privileged internal API — with one honest carve-out: **triggers and
  scheduling are platform lifecycle** (core runtime), not pack
  content; the automations pack contributes tools/skills/checks/components
  *over* that lifecycle. Third-party packs wanting recurring behavior create
  automations through the normal guarded path.
- **Packs are isomorphic modules passed twice** — the same import to
  `createVendo({packs})` (server reads tools/checks/skills, ignores render)
  and to the client root (mounts render). Pack modules must be import-safe
  on the server. Harness/pack contract types live in core (the established
  layering fix).
- **No renaming, ever.** Tool names are global as authored — a skill body
  says `check_report` and projection is a copy, so a prefixed name would
  point the model at a tool that doesn't exist. Collisions fail at boot
  naming both packs; boot-collision IS the namespacing. Pack tool renames
  invalidate grants same as host renames.
- **Packs export downward**: the portable subset (tools + skills) compiles to
  the industry formats — an MCP server, an agentskills.io skill folder, a
  Claude Code plugin (`vendo pack export`). Author once in the rich format
  (checks have no downstream equivalent anywhere; components get at most a
  degraded export via MCP Apps' declared UI — the guarded/checked half stays
  export-less and is the differentiation), project to the poor ones.
- **Skills teach, checks enforce.** A skill is a job description; the harness
  hires its own staff to execute it; if the harness ignores it, the checks floor
  holds anyway.

## 6. App generation (the apps pack)

Not a subsystem — the first pack: generation tools (`validate`,
`search_components`), the v2 pattern as a skill, the checks, the renderer.

Delegation is the *skill's advice, per skill* — a sentence in its body ("run
me in a fresh subagent"), never a pack property or our machinery. Reference
and small-procedure skills are simply read inline; only big loud jobs carry
the advice, and the harness maps it to its native staff (or ignores it — the
checks floor holds either way).

The flow, with any harness: the resident carries a ~30-token skill listing;
on an app ask it dispatches **its own native subagent**; the builder loads the
full skill, writes the plan file (**the plan format is the render format** —
skeleton on screen as soon as the file exists), fans out cheap fill workers
(one per plan group; each sees only its group, its components' docs, and real
sample rows — the blinkers are the coherence and safety design), runs
`validate`, fixes, asks the user through the one door if genuinely ambiguous,
and dies. The resident keeps a ~80-token receipt. The app file is the only
truth; next week any harness opens it and edits. Worker weight (bare call vs
looped subagent) is the harness's business; scope and the checks floor are ours.

`instant()` is this pattern compiled into a specialist harness — one plan
call, parallel bare fill calls, ≤5s skeleton — for hosts that want speed as
the resident. Default-harness choice is a bench question, not architecture.

## 7. Checks

The harness-independent floor. Swap any harness; the floor doesn't move.

- **validate** — code, instant, compiler-shaped: parse, referenced tools/
  components/fields/schedules exist, types fit.
- **review** — a skill + a fresh subagent, nothing more. On app-commit (the
  same hook where fact checks and `can()` already run), the runtime spawns
  one subagent on the wired harness with the review skill: the rubric, the
  original ask verbatim, read-only hands (workspace ro, read-risk queries,
  test-drive; guard-clipped — no writes, no ask_user). **No shared context
  with the builder** — independence is free, not machinery. The builder's
  skill may also advise self-review mid-build (its business); the hook is
  the guarantee — host judgment rules fire regardless, and the shipped
  deterministic security gates can only retire while review always runs. `instant()` keeps its
  internal reviewer. `models.reviewer` overrides the seat; depth
  (rubric-only single call vs full test-drive) is a host dial, defaulting by
  blast radius: org-shared/automation apps get the full test-drive, personal
  quick edits rubric-only. **Failure protocol — a REFUSAL, not a flagged
  version (built 2026-08-01; Yousef's call).** A `block` surviving the pre-land
  fix rounds (`FIX_ROUNDS = 2` in the generation conductor) stops the write at
  the commit path in `apps/src/runtime.ts`: a create fails the build before it
  emits or persists, an edit returns before `persistEdit`, and the person gets a
  plain-language reason on the existing `issues` channel with the finding's
  machine locus and severity stripped (§3). `warn` never blocks. This needs no
  version model, which is the point: an edit that is never written leaves the
  previous app in its row, still serving, for free; a create that is never
  written leaves no app. **What is still absent** (the follow-up lane, with
  skipped tests naming the work at
  `packages/apps/src/checking/review-failure-protocol.test.ts`): the flagged
  version itself, a post-land remediation round, a failure card in the stream
  vocabulary with two choices, an `owner` role (ownership is a subject-string
  compare) and any override path. The host-check carve-out is not merely missing
  but **unrepresentable**: `Finding` carries no provenance, so a host-check
  failure cannot be told apart from a reviewer finding at any waive point —
  fixing that is a shape change, not a wiring change, and it is only needed once
  an override exists. Reviewer traffic runs under its own breaker context, never
  the user's budget.
- **host checks** — plugged in via packs, same guarantee: they fire whether or
  not the builder feels like it.

## 8. Workspace

The agent's filesystem — a façade over the store, materialized onto a real
disk only when a sandbox needs one. Backed by `store` (small files) + `files`
(blobs, size-threshold cutover). The fs interface is **`just-bash`'s
`IFileSystem`** (Vercel, Apache-2.0): we implement it over the store and get
an in-process bash surface (grep/sed/awk/jq, read-only mounts) for
machine-less harnesses — no sandbox needed for file work. Versioning is a
revision column + history rows, not git; commit rules are per mount (§9:
compare-and-swap for `/orgs/`, last-write-wins for `/user/`).

Mounts — one per membership, permissions derived from role:

```
/user/                    the signed-in user — always rw
/orgs/<org>/              one mount PER org membership (Cloud; apps + shared
                          fields; org memory deliberately cut from v1)
/orgs/<org>/teams/<team>/ teams are principals too — same machinery
/host/                    host-authored skills + knowledge — always ro
```

`ls` on a mount is a query, not a directory read — it returns the caller's
visible subset.

**Per-app access is the Google Docs model.** Every org app carries grants of
*principal → level*; a grant can name any principal — a person, a team, the
whole org, any mix per app:

```
finance-dashboard:  org:acme → viewer · team:finance → editor · dana → owner
```

- The level vocabulary is closed and ships with us: `viewer` (see + use) ·
  `editor` (edit) · `owner` (edit + share + delete). A viewer who asks for a
  change gets a consumer-voice fork offer ("I can't change the team's copy,
  but I can make you your own"), never a bare refusal. Assignments are fully
  flexible; *defining new level types* is not a surface (`operator` for
  automations is deferred to the guard brainstorm). Effective access = max of
  your grants; org admins are implicit owners.
- **Live sharing implies the org workspace.** A personal app has one member;
  the share dialog promotes silently and sets grants ("Share → finance as
  editors" = promote + grant). To hand someone a copy instead, fork. Personal
  workspaces stay single-player; the org owns what outlives people.
- Enforcement is the same one point as everything else: the façade and the
  wire check the grant; no second permission system.

### How permissioning enforces

- **One function, three doors.** `can(principal, level, thing)` — resolved
  from ownership + memberships + grants, all rows — is the only permission
  logic; the workspace façade, the wire, and the MCP door all call it. Harnesses,
  packs, and tools are permission-blind: they just perceive a smaller world.
- **The host's identity system IS the org** (LOCKED with Yousef 2026-08-01,
  after a two-agent industry survey: every surviving embedded vendor —
  Liveblocks, TipTap, Metabase, Sigma, LaunchDarkly — asserts memberships
  per session and stores only grants; the one org-chart-sync vendor, Cord,
  is dead). Memberships are never Vendo rows: the same auth answer that
  names the user (`fromSession(getUser)`) also names their orgs and teams —
  a `memberships` callback on the auth preset, one query against the host's
  own tables. True on every request, straight from the host's source of
  truth, no second org chart, no sync, no console channel into the host's
  database. Because the callback is host server code in the same
  deployment, unattended runs can call it too — no session needed, which is
  the one case that forces syncing on third-party clouds (Stream) and does
  not exist for us. The Cloud console never manages a BYO org; it MAY show
  a read-only *observed* view (last-asserted users/teams/shares, the
  Metabase/LaunchDarkly pattern) for support, built from data already
  flowing through the deployment. The only rows Vendo stores are the Vendo-specific part —
  grants (app → principal → level) — written by the Share dialog inside the
  embedded surface, behind the `store` adapter the host already wired
  (their Postgres or Cloud's hosted store), host-SQL-queryable. Cloud's
  console manages memberships only for hosted-tier customers with no
  identity system to lend us — there it writes to its own hosted store.
  Gating stays key + meter, nothing else: sharing is multi-party
  coordination, so share/promote throw `cloud-required` without a key even
  though the auth answer may already carry orgs; enforcement (`can()`) is
  OSS and never key-conditional. No key → no grants can exist → `can()`
  degenerates to "is it yours?". No hidden branches.
- **For sandboxed harnesses, `can()` runs at exactly two moments** — there are
  no checks inside the box, so the box is born filtered:
  *checkout* — materialization is a query ("all files viewer+ reaches"),
  editor-level mounts rw, viewer-level ro, invisible apps simply absent;
  *commit* — sync-back checks `can(editor)` per changed file against live
  rows before the store accepts it (the diff is the audit). In-process harnesses
  have no box: same `can()`, every façade call.
- **The box is a snapshot.** Mid-session revokes don't un-materialize what a
  session already saw (reads age gracefully, like a Docs revoke); they bite
  at next checkout — and writes never sneak through, because commit always
  checks live rows.
- **Served org apps are a wire door, not a snapshot with viewers.** The
  registered URL checks `can(viewer, app)` per request against live rows;
  served processes get a read-only workspace and reach per-user data through
  tools; file writes from a served app are a job with a commit; the reviewer
  rubric checks nothing private is baked into the served snapshot.

Sharing is two verbs: **fork** (copy into your workspace, fresh ids,
`forkedFrom` provenance — take-and-adapt, registry import) and **promote**
(move the canonical into `org/` — team apps, org fields; survives departures).
The registry is a shelf of dead snapshots — publish = snapshot out, import =
fork in; no live links across org boundaries. Per-user data inside a promoted
app needs nothing new: app storage is already subject-partitioned.

Store write law: **O(messages + tool calls + files changed), never O(tokens).**
Deltas buffer in memory; the UI streams from the wire, not the DB. A turn
lands as ~15 rows. Transcripts store **one row per message** (accepted
migration, wave-1 store lane — replaces today's whole-transcript row
rewritten per turn, which honored the row count but not the bytes; touches
the store contract and the erase cascade, done deliberately).

## 9. Sandboxes

A sandbox exists for one reason: **a spawned-CLI harness needs a machine to
live on.** No placement layer, no capability tools, no ladder.

- **One machine per session.** `sandbox.acquire(workspace)` — acquired when a
  spawned harness starts, reused across its turns, idle-TTL disposed. Warm
  pools and ephemerality are adapter internals, adopted only if a bench says
  so.
- Materialize workspace mounts in (ro mounts as read-only binds); sync
  changed files out at turn end — **except designated hot paths (the app and
  plan files), which sync mid-turn** so the skeleton renders the moment the
  plan file exists, whoever wrote it (the in-box `vendo validate` shim
  doubles as a sync point); O(files changed) preserved. Commit is per-file
  compare-and-swap for `/orgs/` (stale base → a conflict outcome the harness
  resolves — resolving is thinking); last-write-wins for `/user/`. The store
  never stops being the truth.
- **The box holds a workspace copy and a turn-scoped token, nothing else** —
  authority calls come back out through the guard; a compromised box holds
  files its user could already see. (Today's box injects real secret values
  and the inference key — a deliberate v0 exception; reconciliation is parked
  to the secrets brainstorm, §12, recorded so the contradiction is decided,
  not silent. The inference endpoint is a named standing egress exception:
  a boxed harness must reach a model to think.)
- **Spawned-CLI harnesses run in the sandbox by default** — `claudeCode()`
  without a sandbox adapter is a boot error; running the CLI on the host's own
  server is the explicit opt-in `machine: "local"`.
- No adapter wired → spawned harnesses are unavailable (boot error), and
  machine-less harnesses lose nothing: they have in-process bash over the
  workspace (§8). The adapter slot is the switch; no capability booleans.
- Durable Objects and friends appear **behind** seams (a Cloud adapter),
  never **in** them.

## 10. Config — the whole surface

```ts
createVendo({
  auth: fromSession(getUser),
  tools: hostTools,                                  // vendo init / sync
  harness: claudeCode(),                             // default: vendo()
  packs: [apps(), automations(), complianceReports], // default: apps()
  models: { default: anthropic("claude-fable-5"),    // optional; resolution:
            reviewer: openai("gpt-5.6") },           // seat → default → borrow
                                        // the loop's → Cloud gateway →
                                        // first-use error naming the key
  store: postgres(env.DATABASE_URL),
  files: s3(bucket),                                 // optional
  sandbox: e2b({ warmPool: 2 }),                     // optional
});
```

Six slots + `packs`, `defineHarness`, `definePack`, per-turn options. Day one
is one key: `vendo init` writes `.vendo/`, `createVendo({auth})` reads it —
`tools:` is the explicit override, not the quickstart. Everything else
defaults or degrades honestly. Composition rules are boot-time errors
("Claude Code needs a sandbox adapter"), never runtime surprises.

- **One model-resolution order, one place:** a harness reads its seat
  (`models.default` resolved: seat → env ladder → Cloud gateway → first-use
  error); setting both `harness: claudeCode({model})` and `models.default`
  for the same seat is a boot error, not a precedence puzzle. The seat map is
  closed and typed (default / reviewer / judge / fill).
- **`files` unset is a documented default, not a gap**: blobs live in the
  store up to a size cap; the first over-cap write fails naming the fix.
- The build produces a **29→6 migration table** — every current
  `createVendoConfig` key gets a stated destination (folded into a slot, a
  pack option, a harness option, or deleted); no key vanishes silently.
- Roadmap: `vendo sync` emits typed host-tool declarations
  (`.vendo/tools.d.ts`) so host code gets typed names and args.

## 11. The Cloud line

Unchanged laws, applied: personal workspace, BYO everything = OSS
single-player. Org workspaces, sharing, registry, hosted automations, hosted
placement, the model gateway = Cloud — same code, another principal, another
adapter, lit by key + meter. DO-backed store/sandbox/automations adapters are
Cloud implementation details behind OSS seams.

## 12. Consent: permissions upfront, popups only for the irreversible

- **Apps and automations get their permissions beforehand, in one honest
  card** generated from their declared tools (the plan declares them; the
  automations enable flow already works this way — grant sets, one decision).
  The build turn itself needs no card: reads are silent by law, so building
  and filling run legally, and the card is generated when the plan lands,
  gating the app's first *write*. Approved once → that app runs silently.
- **Grants are per-person.** A shared app shows each member their own card on
  first write-bearing use; a creator's approval is never anyone else's.
- **Bundles are proposed, never blank.** A card never asks the user to fill a
  form: everything is pre-filled from what the app declares (and, where a
  limit is sensible, a proposed one), so the normal case is a single tap and
  editing is optional. Whole-registry declarations are rejected, not bundled;
  a declared set is bundle-eligible only if every member is a read or a
  non-destructive write.
- **The grant set is bound to the app's intent, not just tool names.** An
  app-intent hash (declared toolset + scopes + trigger + run body + the
  user-visible name) rides the set; any change invalidates it and re-asks
  **the delta only** — reusing the existing invalidated-grant + stale-hash
  audit path. An edit by anyone other than the sponsor invalidates
  sponsorship (§13 adoption fires on the *edit* event, not only on
  departure). Promote re-mints the set; copy paths strip grant sets by field
  whitelist, exactly as approval state is stripped today.
- **THE LAW: destructive and external actions are never unattended.**
  Automations may read and write; they may **not** move money, message
  humans, or delete — those tools are not projected into an automation run at
  all. Not with a limit, not with a condition, not with an admin override.
  The honest pattern replaces them: the automation *prepares*, the human
  *sends* — "your 12 reminders are ready · [Send all]" in the morning, one
  tap, real arguments visible. Unattended work, attended irreversibility.
  Eligibility never rests
  on the AI-assigned risk label alone: a second mechanical vote (HTTP method +
  verb shape) must agree, and disagreement treats the tool as destructive.
- **Interactively, destructive actions are a normal confirm.** She clicked, so
  she is there: the popup appears in the flow with real amounts and
  recipients, she taps, the call proceeds (§3). No conditions machinery, no
  judge at decision time, no free-text policy language anywhere.
- **Reads are silent, always.** Ad-hoc chat asks (no app, no bundle) keep
  ask-once-with-remember.
- **Widening this later is a predicate, not a subsystem.** The guard already
  asks "is this tool allowed here?" on every call; a future host opt-in answers
  that one question differently, on the path every call already takes.
- **Cards say what will happen, completely.** Consent surfaces are the one
  carve-out from the voice law's no-internals rule: plain language, but one
  line per mutating step (never a single summary line for a compound), a
  mechanically-derived risk line the model cannot author, and the exact tool
  name and arguments one tap away. Tool `title` joins the descriptorHash
  preimage, so a retitle invalidates grants like a rename.
- **Enable is atomic with its grant set**: an app or automation is never armed
  with pending permissions. One set per app keyed by (app, tool);
  re-declaration may only add, and an addition cards only the delta.

## 13. Automation authority: sponsorship

An automation always runs as a named person — its **sponsor** (creator by
default, an app `owner`). Because automations can only read and write (§12),
sponsorship is a light ceremony, not a security perimeter: the sponsor's
grants are the authority, and a missing one fails the run with a card (§3).
Sponsorship is invalidated by the sponsor leaving, their grants invalidating,
**or anyone else editing the app** (the app-intent hash, §12); the automation
stops and asks the app's editors+ to **adopt** — approving its reads and
writes as themselves, one card. The ask is not a new approval primitive
(approvals stay strictly self-subject): the stopped run is a card in the app
itself, shown to whoever editor+ opens it next; the first to accept adopts.
Nothing is pushed to a set of people (his call, 2026-08-01). When the §3
notification hook is eventually built, it announces this same card — an
upgrade, not a rework. The automation labels its window ("runs with
Dana's access") and names a wider editor set when one exists. Runs are visible
in a consumer-voice history rendered from the audit rows — a render, not new
machinery. No non-human principal ever acts.

## 14. Guard policy — carried forward, plus the org layer

Existing machinery survives untouched: host policy config + the judgment
channel (`tools.json < judgments.json < overrides.json`), the judge, approvals
— gaining scoped grants (§12) and sponsorship adoption as callers.
New: **org-admin policy** (Cloud) — a policy layer org admins set over their
members' agents ("finance may not approve host_transferMoney above $10k"),
living as a policy file in the org workspace, managed via the console,
evaluated by the same guard between host policy and user approvals. Host
policy always wins over org policy; org policy tightens, never loosens.

## 15. Structure — modular and clean, as law

The same shape repeats at every level, and that repetition is the design:
a harness is one function, an adapter is one interface with one job, a pack is
four slots, a tool is a name and a schema.

- **One concept per package, one job per file.** No package reaches sideways
  (the dependency guard enforces it between blocks; new packages declare their
  place). Nothing with a single caller survives as an abstraction — that rule
  is what deleted the placement layer, the job/session split, and the
  code-execution family.
- **The workspace layout is product, not implementation.** Paths are
  predictable and readable by humans and agents alike
  (`/user/apps/<app>/…`, `/host/skills/<name>/SKILL.md`); there is no `misc`,
  no dumping ground, no path whose meaning depends on who wrote it. The
  layout is fixed in the build contract, not discovered per lane.
- **Additive by construction.** Every persisted or wire-crossing shape is a
  tagged union or a format-tagged document, so tomorrow's variant is a new
  member and yesterday's reader fails closed. This is what makes deferring
  features (unattended destructive actions, code execution, conditions) cost
  nothing: the extension points are the same ones already carrying traffic.

## 16. Open — next brainstorms
- **Secrets reconciliation** (parked from the review): handles vs scoped real
  values in the box; gating the inference key. Owns the §9-vs-box-env
  contradiction.
- **The automations pack**: grants-as-approval + the run history, reshaped over
  the platform trigger lifecycle (§5).
- **Display & remix**: the launcher (ordering, admin-featured), pins as the
  second render mode (feature bundles grafted into host screens), what a
  member sees when a pinned remix targets their screen. Design-skill work,
  with mockups. Architecture already committed above and *not* deferred: the
  failure-card home + notification hook (§3), consent card completeness
  (§12), and the consumer run history (§13) — the design pass styles
  them, it does not decide whether they exist.
- **Benches**: default resident harness (vendo() vs Claude Code + skill on the
  simple-ask corpus) · reviewer depth dial · fill worker weight/tier/
  concurrency · time-to-skeleton gates (≤5s typical stands until re-measured).

## 17. What this supersedes

The 2026-07-28 generation-pipeline-v2 spec's mechanics survive inside the apps
pack (plan text, groups, worker blinkers, edit-like-a-file, computed values, the
honest cannot-path); its pipeline framing is absorbed by §2/§3.

Of the frozen v0 seams, `guard.bind`, `LanguageModel`, and subject partitioning
carry forward unchanged. The **store** seam changes deliberately, in two places:
one row per message for transcripts (§8), and the new workspace tables.
