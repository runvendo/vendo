# Build contract — exact shapes

**2026-07-30.** Companion to `2026-07-30-embedded-agent-architecture-design.md`
(the architecture; read it first). This file exists because four reviewers
independently found the spec unbuildable *as text*: it states laws, not shapes.
Everything here is a shape two lanes would otherwise invent differently.

Rule for builders: **if it is in this file, it is frozen — propose changes to
the orchestrator, never diverge locally.** If it is *not* here and not in the
architecture spec, decide it locally and note it in your lane report.

## 1. The harness contract

```ts
// @vendoai/core — types only, so every block may speak them
import type { UIMessage } from "ai";
import type { LanguageModel } from "ai";

export interface Harness<Options = unknown> {
  readonly name: string;                     // "vendo" | "instant" | "claude-code" | …
  readonly optionsSchema?: StandardSchemaV1;  // declares per-turn-overridable knobs
  readonly requires?: { sandbox?: boolean };  // boot-time composition check
  /** Amendment 2026-08-03 (claudeCode() redesign, D2 + D4): how this harness
   *  wants the equipped-tool surface shaped. `curated: false` skips the
   *  discovery loadout and `find_tools` with it (the ctx safety projection
   *  still runs — this is curation, never the law); `withhold` names tools
   *  never listed to and never callable by this harness. */
  readonly toolSurface?: { curated?: false; withhold?: readonly string[] };
  run(turn: Turn<Options>): AsyncGenerator<HarnessEvent, void, void>;
}

export interface Turn<Options = unknown> {
  /** Canonical transcript, oldest → newest. Ours; read-only. */
  readonly messages: readonly UIMessage[];
  readonly tools: TurnTools;
  readonly skills: TurnSkills;
  readonly workspace: WorkspaceFs;      // §3; the harness's file hands
  readonly models: ResolvedModels;      // §4
  readonly state: TurnState;            // §2.3
  readonly options: Options;            // parsed by optionsSchema, incl. per-turn overrides
  readonly signal: AbortSignal;
  /** Amendment 2026-07-31 (ratified after the live proof): the assembled system
   *  prompt — product brief, catalog, knowledge index — RIDES THE TURN. It was
   *  a construction dep of `vendo()`, but a host-named `harness: vendo()` is
   *  constructed at boot where no RunContext exists, so the documented opt-in
   *  silently thought with a ZERO-character prompt (measured: 2068 on the two
   *  working paths, 0 on the documented one). Composition assembles it per
   *  turn; `vendo({system})` stays as an explicit override. */
  readonly system?: string;
  /** Present iff the caller proved presence (a click/message/submit). */
  readonly interactive: boolean;
  /** Amendment 2026-08-01 (wave 2, lane E ratification): the conversation's
   *  stable identity RIDES THE TURN. Session-owning adapters need a stable
   *  per-conversation key (machine pools, native session refs); lane E had to
   *  derive one from `messages[0].id` — a client-minted value that history
   *  edits can orphan. The runtime already holds threadId; passing it is
   *  simply true. Adapters must treat it as opaque. */
  readonly threadId: string;
}
```

`defineHarness(def): Harness` returns the harness value itself. A harness that
needs host dependencies is authored as a plain factory returning that value
(`export const acmeHarness = (deps) => defineHarness({...})`) — there is no
separate factory concept in the contract.

### 1.1 Tools

```ts
export interface TurnTools {
  /** Never throws. Guarded, audited, and mirrored before it resolves. */
  call(name: string, args: Json): Promise<ToolResult>;
  // amendment 2026-07-30: the idempotencyKey opt was removed — the §7 effect
  // ledger keys on run/turn id + input hash internally; no caller read it.
  /** Currently-equipped tools (post-curation). */
  list(): Promise<ToolListing[]>;
}

export type ToolResult =
  | { status: "ok"; output: Json }
  | { status: "denied"; reason: string; needs?: DeniedNeeds }   // guard said no / needs a human
  | { status: "error"; error: { code: string; message: string } };

export type DeniedNeeds =
  | { kind: "approval"; approvalId: string }   // a card is waiting for the user
  | { kind: "connect"; toolkit: string }       // an account must be connected
  | { kind: "unattended-destructive" };        // §12 law: never available off-interaction

export interface ToolListing {
  name: string; title: string; description: string; risk: RiskLabel;
  /** Amendment 2026-08-03 (#747 landed): `risk` widened from the three-value
   *  union to `RiskLabel`, which adds `ungraded` — a tool nobody has judged.
   *  Read design §12: `ungraded` asks by default and is withheld from an
   *  unattended run, exactly like `destructive`. */
  /** Amendment 2026-07-30: JSON Schema for the tool's input — every in-process
   *  harness must hand schemas to its model; JSON Schema is the interchange. */
  inputSchema?: JsonSchema;
  /** Amendment 2026-08-03 (harness redesign D5): the host's DECLARED result
   *  shape, carried verbatim from the descriptor when extraction found one —
   *  the model learns a query's fields from the listing, not by calling it. */
  outputSchema?: JsonSchema;
}
```

Mapping from the frozen core `ToolOutcome` (unchanged: `ok | error |
pending-approval | blocked | connect-required`) is the runtime's job, not the
harness author's: `pending-approval` → `denied{needs:approval}` (interactive
callers block first, §1.4), `blocked` → `denied`, `connect-required` →
`denied{needs:connect}`. Three statuses is the whole surface a harness sees.

### 1.2 Skills, workspace, models

```ts
export interface TurnSkills {
  list(): Promise<SkillListing[]>;               // ~30 tokens each; always cheap
  load(name: string): Promise<string>;            // full SKILL.md body, on demand
}
export interface SkillListing { name: string; description: string; }
```

`workspace` is the `WorkspaceFs` of §3. `models` is §4's `ResolvedModels`.

### 1.3 Harness state

```ts
export interface TurnState {
  get(): string | undefined;     // opaque to us
  set(value: string): void;      // persisted at turn end
  clear(): void;
}
```

Cleared by the runtime on arbitrary history edits or a harness swap; a prefix
truncation uses the harness's native rewind instead (adapter's business).

### 1.4 Approvals

`call()` resolves; it never suspends the process.

- `turn.interactive === true`: the runtime shows the card and **awaits the tap**
  inside `call()`, up to `APPROVAL_WAIT_MS = 90_000`, holding no sandbox lease.
  Tap → `{status:"ok"}` (or `denied` if refused). Timeout → `denied{needs:approval}`.
- `turn.interactive === false`: no wait. `denied{needs:approval}` immediately;
  the runtime raises the failure card (§3 of the architecture spec).

### 1.5 Events (closed vocabulary)

```ts
export type HarnessEvent =
  | { type: "text";   delta: string }
  | { type: "status"; label: string }             // consumer-voice; ephemeral, screen-only
  | { type: "error";  message: string; code?: string }   // consumer-voice; no internals
  | { type: "usage";  inputTokens: number; outputTokens: number;
      cacheReadTokens?: number; cacheWriteTokens?: number; model?: string };
```

Routing (frozen): `text` → screen + transcript · `status` → screen only ·
`error` → screen + audit (amendment 2026-07-30: the original "…+ transcript"
leg was aspirational — the ai-SDK error chunk is not persisted and today's
shipped agent does not persist errors either; parity with today wins, and
audit ⊇ transcript holds trivially) · `usage` → audit/metering only. Tool
calls are mirrored by the runtime, never yielded. Adding a member later is a
breaking change for host renderers — this list is closed for v1.

Amendment 2026-07-30: `status` rides a **transient** `data-vendo-status` wire
part owned by `@vendoai/harnesses` (never persisted, never in
`stream-parts.ts` — core stays untouched). `error`'s host-observable
affordance must match today's agent behavior exactly (whatever chunk/part the
shipped loop raises today, the runtime raises — no new failure UX in wave 1).

### 1.6 Who runs a harness

`@vendoai/harnesses` owns the **runtime**: it builds the `Turn`, converts
`HarnessEvent`s plus mirrored tool calls into the existing ai-SDK UIMessage
stream with today's `data-vendo-*` parts (`packages/core/src/stream-parts.ts` —
unchanged; no new wire format), persists the transcript, and enforces the
routing table. Harness adapters contain no persistence and no wire code.

**Hot-path render seam** (orchestrator addition, 2026-07-30, ratified with
Yousef — closes the gap between §3.5's mid-turn sync and "the skeleton renders
the moment the plan file exists"): on every store write to a hot-path file
(`app.vendo`, `plan.vendo`) — façade tool edit, in-process bash, or sandbox
mid-turn sync — the **runtime** parses the content and, iff it parses, emits
today's `data-vendo-view` part: same payload shape (assembled tree), same
stable per-app stream id, same server-authoritative field stripping, same
progressive query-resolver data fill (all existing code, relocated from the
engine). An unparseable write emits **nothing** — the last good view stays on
screen and the brokenness reaches the harness through `validate`, never the
user. Granularity is per file save (accepted trade: a harness that writes once
at the end shows nothing until it finishes — a bench-visible quality
difference, not a correctness one). Harnesses never yield view events;
`HarnessEvent` stays closed.

*Amendment 2026-08-03 (claudeCode() redesign, D4 files-first).* The
"progressive query-resolver data fill" above was specified here and **never
wired**: `fillData` had no caller in the repo, so every harness-authored app
painted its structure and showed no data at all (measured in a live boxed run).
Wiring it needed an app half, because the fill runs the app's queries as the
caller and a file-authored app had no row to run them against: `AppsRuntime
.authored({ appId, compiled }, ctx)` upserts the row through the engine's own
writer and resolves the tree through the same guard-bound caller `open()` uses
(`venue: "app"`, one guard decision per query), which is also what makes
`vendo_apps_open` and the Apps list work for an app nobody called
`vendo_apps_create` for. The seam now emits the skeleton FIRST and re-emits with
data on the same stream id, so resolving real queries cannot cost the
seconds-to-skeleton promise. `authored()` reads an existing row only when the
caller may write it — an unscoped read let one subject's file land under another
subject's appId and execute a `fn:` query on their machine. Known gaps at
landing: island admission (`prepareIslands`) does not run on this path, so
`validate` is the review floor; a deleted `app.vendo` leaves a listable row
(`vendo_apps_delete` is the real verb); a served (`ui: "http"`) app would be
demoted if a file were written for its id (experimental, off by default).
`authored()` does not call `persistEdit`, but it now takes the three things
`persistEdit` does that a save owes (checker round 3, same day, all on the
mayWrite branch so no foreign row is read or announced): §9.9's
`onDocumentEdit` announcement on every save that lands — a rewrite leaves
`trigger` verbatim, so the intent hash does NOT move and this hook is the only
thing that can invalidate a third party's rewrite or re-bind the sponsor's own;
a `history.append` undo point per changing save (skipped when the save changed
nothing); and `assertCurrent`'s baseline re-check before the put, which refuses
a save whose document carries a stale history forward rather than reverting an
`edit()` that landed in the window. The residual TOCTOU is persistEdit's own
(no revision on the store seam). Pinned component sources now survive a save
whose text omits them — `pins` carries on naming them, and a pin with no source
is not a pin.

## 2. Layering (dependency-guard rows)

```
core                      ← Harness/Turn/Pack contract types live here
harnesses → core, agent, apps, guard      (second multi-block package, after vendo)
vendo     → everything                    (unchanged)
```

Add `harnesses` to `scripts/dependency-guard.mjs` LAYERS with exactly those
edges. `defineHarness`, `definePack`, `Turn`, `HarnessEvent`, `Pack`, `Check`,
`Finding` are **type-only** exports from core; implementations live in
`harnesses` / `apps` / `vendo`. Name collision to avoid: `@vendoai/agent`
already exports `buildVendoToolPack` / `VendoPackTool` (the BYO tool pack) —
the new `definePack` must not shadow or rename those.

## 3. Workspace

### 3.1 Path layout (frozen)

```
/user/apps/<appId>/app.vendo        the app document, printed wire text
/user/apps/<appId>/plan.vendo       the plan (renders as the skeleton)
/user/memory/<name>.md              agent notes
/user/files/<name>                  uploads + generated artifacts
/user/scratch/<name>                intra-turn junk; never synced back
/orgs/<orgId>/apps/<appId>/…        same shape, org-owned (wave 3)
/host/skills/<skillName>/SKILL.md   host + pack skills (read-only)
/host/knowledge/<name>              host-authored reference (read-only)
```

Rules: no other top-level mounts; no `misc`; `appId` is the store's app id
verbatim; a path's meaning never depends on who wrote it.

### 3.2 The filesystem interface

We implement **`just-bash`'s `IFileSystem`** (Apache-2.0, `vercel-labs/just-bash`)
over the store, and expose it as `WorkspaceFs = IFileSystem` plus:

```ts
export interface WorkspaceFs extends IFileSystem {
  /** Commit changed files. Per-mount rules: /orgs = CAS, /user = last write wins. */
  commit(opts?: { message?: string }): Promise<CommitResult>;
}
export type CommitResult =
  | { status: "ok"; changed: string[] }
  | { status: "conflict"; paths: string[] };   // stale base; the harness re-reads and re-applies
```

`IFileSystem.getAllPaths()` and `resolvePath()` are **synchronous** in just-bash.
Decision: the façade builds a **path index at turn start** and updates it on
every write; content is always read through the store. Mount read-only-ness is
enforced with `MountableFs`'s `readOnly`.

### 3.3 Tables

```sql
vendo_workspace_files (
  path          text  not null,        -- full path, e.g. /user/apps/app_1/app.vendo
  owner         text  not null,        -- subject, or org id for /orgs mounts
  content       text,                  -- inline iff <= WORKSPACE_INLINE_MAX_BYTES (65536)
  blob_ref      text,                  -- else the files-adapter key
  bytes         integer not null,
  revision      integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (path, owner)
);
create index on vendo_workspace_files (owner);

vendo_workspace_history (               -- undo + provenance; append-only
  id            text primary key,
  path          text not null,
  owner         text not null,
  revision      integer not null,
  content       text,                  -- prior content (or blob_ref)
  blob_ref      text,
  intent        text,                  -- consumer-voice, e.g. "made the chart blue"
  at            timestamptz not null default now()
);
create index on vendo_workspace_history (path, owner, revision desc);
```

Both join `ERASE_TABLES` (`packages/store/src/erase.ts`) and the
anon→signed-in adoption path (`helpers/subjects.ts`), keyed on `owner`.
History retention: `WORKSPACE_HISTORY_LIMIT = 50` per path (same as app history).

### 3.4 Files adapter

```ts
export interface FilesAdapter {                       // core, type-only
  put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | undefined>;
  delete(key: string): Promise<void>;
}
```

Unset → the store's `blobs()` backs it, capped at `FILES_STORE_MAX_BYTES`
(5 MiB, matching today's app-blob cap); the first over-cap write fails with
`VendoError("validation")` naming the fix ("wire `files:`"). `s3(bucket)` is the
one shipped implementation (S3-compatible covers S3/R2/Supabase/MinIO).

### 3.5 Materialization

Checkout writes the caller's visible files to the sandbox disk (`/orgs` at
viewer level → read-only bind). Sync-back is **diff-based, per file, never
wholesale**: only paths whose content hash changed are committed, each carrying
its checkout `revision` as the CAS base. `/user/scratch/**` is never synced.
Hot paths — `app.vendo` and `plan.vendo` — sync mid-turn (that is what puts the
skeleton on screen); everything else at turn end.

## 4. Model seats

```ts
export type Seat = "default" | "reviewer" | "judge" | "fill" | "verifier";
export type ResolvedModels = Readonly<Record<Seat, LanguageModel>>;
```

Config takes `models?: Partial<Record<Seat, LanguageModel | string>>`.
Resolution per seat: explicit seat → `default` → the env credential ladder →
Cloud gateway (if `VENDO_API_KEY`) → a first-use error naming the exact key.
Migration from today's `ModelsConfig`: `agent → default`, `paint → fill`,
`judge` unchanged, `knowledgeVerifier → verifier` (amendment 2026-07-30: the
fold into `default` was premised on it having no independent consumer — that
premise was FALSE, `server.ts` still reads it, and folding silently repointed
the agent model when a host set only `knowledgeVerifier`. It keeps its own
seat; the knowledge check's cheap/fast model must never be the agent's). Deprecated `model:` / `paint:` keys keep
their existing shims for one minor. **Boot error** if a harness option sets a
model *and* `models.default` is set for the same seat.

## 5. Packs

```ts
export interface Pack {
  name: string;
  tools?: ToolDefinition[];
  skills?: PackSkill[];
  checks?: Check[];
  components?: ComponentRegistry;      // the SHIPPED registry shape, see below
}
export interface PackSkill { name: string; description: string; body: string; }
```

- **`components` uses today's vocabulary**, unchanged from
  `packages/core/src/catalog.ts`: `{ component, description, props?, examples?,
  remixable? }` — the server ignores `component`, the client mounts it. (The
  architecture spec's `{schema, render}` sketch is superseded by this line.)
- **`checks` reconciles with the shipped `Check`** (`packages/apps/src/checking/types.ts`):

```ts
export type Check =
  | { name: string; kind?: "fact"; run(input: CheckInput): Promise<Finding[]> }
  | { name: string; kind: "judgment"; rule: string };   // joins the reviewer rubric
// amendment 2026-07-30: `kind` is optional on the fact variant and the floor
// runs anything NOT explicitly "judgment" — a safety floor never opts a check
// out by omission (a kind-less legacy host check must keep firing).

export interface CheckInput { document: AppDocument; request: string; plan?: AppPlan; }
export interface Finding { severity: "block" | "warn"; where?: string; message: string; }
```

`kind` is added to the shipped shape (defaulting to `"fact"` for existing
in-repo checks); judgment rules are appended to the reviewer's rubric list as
separate lines, never concatenated into one string. Findings are
order-independent; a check that throws yields one `warn` and never blocks a
build.
- Names are **global as authored** — no prefixing. Boot fails on collision,
  naming both packs.
- **Every boot gate ships a test that proves it can still FAIL** (lesson,
  2026-07-30): a gate reading the wrong source looks identical to a gate that
  finds nothing wrong — twice this wave a *fix* was the defect and only a
  red-green test caught it. A pass-only test is not evidence a gate works.
- A pack module is imported twice (server + client) and must be import-safe on
  the server.

## 6. Transcript storage (the accepted migration)

```sql
vendo_thread_messages (
  thread_id   text not null,
  id          text not null,            -- client-minted UIMessage.id
  seq         integer not null,         -- ordering; monotonic per thread
  message     jsonb not null,           -- one UIMessage
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (thread_id, id)
);
create index on vendo_thread_messages (thread_id, seq);
```

`vendo_threads` keeps `id, subject, title, revision, created_at, updated_at`
and **loses `messages`**. Reads reassemble by `seq`. Writes: one row per new or
edited message, per-row CAS on `revision`; the thread row's `revision` still
guards title/metadata. Ordering never derives from timestamps (approval flips
rewrite older messages). Backfill follows the existing versioned-migration
pattern in `packages/store/src/schema.ts` (`SCHEMA_VERSION` bump + one
`DATA_BACKFILL` step splitting existing arrays). Add the table to
`ERASE_TABLES`, the subject-adoption path, and `02-store.md`'s row map.

Helper surface (orchestrator addition, 2026-07-30 — lane D builds it, lane A's
runtime consumes it; style matches `helpers/threads.ts`):

```ts
export function threadMessageStore(store: VendoStore): {
  /** One row per message; per-row CAS on `revision` for edits. */
  upsert(principal: Principal, threadId: ThreadId, message: UIMessage, seq: number): Promise<void>;
  /** Reassembled by seq, oldest → newest. */
  list(principal: Principal, threadId: ThreadId): Promise<UIMessage[]>;
}
```

## 7. Consent shapes

```ts
export interface GrantSet {
  id: string;                    // gset_…
  appId: string;
  subject: string;               // per person, always
  intentHash: string;            // sha256 over the canonical intent, below
  tools: string[];
  createdAt: string;
}
```

`intentHash` preimage (RFC 8785 canonical JSON): `{ tools: string[] (sorted),
trigger, runBody, name }` — the app's declared toolset, its trigger, its run
body/prompt, and its user-visible name. Any change → the set is invalidated →
re-ask **the delta only**, reusing today's `invalidatedGrant` +
stale/current-hash audit path. `title` joins the `descriptorHash` preimage
(`packages/core/src/descriptor-hash.ts`) so a retitle invalidates like a rename.

Effect ledger (makes fail-and-re-run correct):

```sql
vendo_effects (
  key         text primary key,   -- sha256(runId|turnId + tool + exactInputHash
                                  --        + ordinal), where ordinal counts
                                  --        prior identical calls in the same
                                  --        (run, turn) — amendment 2026-07-30:
                                  --        without it, two legitimately
                                  --        intended identical mutations (pay
                                  --        $10 twice) silently collapse to one
  subject     text not null,      -- amendment 2026-07-30: outcome holds tool output,
                                  -- so the ledger must join the erase cascade
  outcome     jsonb not null,
  at          timestamptz not null default now()
);
create index on vendo_effects (subject);
```

Written inside the guard's execute path for mutating calls only; a call whose
key already exists returns the recorded outcome instead of executing. The
table joins `ERASE_TABLES` and the subject-adoption path, keyed on `subject`
(orchestrator amendment, 2026-07-30 — the frozen v1 shape had no subject
column and was therefore un-erasable).

## 8. Explicit wave-1 cuts (do not build)

`/orgs/**` mounts and `can()` beyond ownership (wave 3) · steering
(mid-turn user input) · the `vendo validate` in-box CLI shim · `vendo pack
export` · conditions on grants · any code-execution or app-serving tool ·
scope constraints on grants (the architecture's §12 law removes their v1
need).

Wave-1 `can()` is exactly today's rule: a path under `/user/` belongs to its
subject, `/host/` is read-only for everyone. Nothing more.

**The method axis escalates by shape, and DELETE is the destructive line**
(clarification 2026-07-31, ratified after a builder pushed back on an
over-broad brief): the binding's shape is *derived* into
`ToolDescriptor.bindingRisk` — `DELETE` → `destructive`; any other mutating
shape (POST/PUT/PATCH, a tRPC/GraphQL mutation, a server action) → `write`; a
read shape → absent. It is derived, never host-authored, carries no `"read"`
member so a risk can never be *lowered* through it, and stays out of the
`descriptorHash` preimage so no grant is invalidated. Treating POST/PATCH as
destructive was rejected with evidence: 12 of 39 extracted demo-host tools are
POST-bound and 8 are hand-declared `write`, so it would mean no automation
could ever write anything — contradicting §12's "Automations may read and
write" and deleting the law's own prepare-then-human-sends path. `write` still
escalates: it disqualifies the read short-circuit, which is what moved
`maple_records_purge_list` from offered-to-every-automation to withheld.

**The mechanical second vote applies where the label is AI-ASSIGNED**
(clarification 2026-07-31): design §12 says eligibility "never rests on the
*AI-assigned* risk label alone" — the second vote exists to catch an extractor
or connector mislabelling someone else's API. **Vendo-authored tools** (the
vendo verbs, `ask_user`, workspace tools) carry a hand-written, reviewed
`risk`, so their declared label is authoritative and the vote adds only false
positives: `ask_user`, `validate`, and `search_components` all voted `write`
purely because their trailing token is a noun, which would let a host policy
card a *question* and write it an effect-ledger row. Fail-closed stays the rule
for every AI-assigned label.

**THE LAW's predicate is PRESENCE, never the venue label** (clarification
2026-07-31, found at integration): "unattended" means *nobody acted* —
`presence === "away"`. A `venue: "automation"` context with
`presence: "present"` is a **ceremony**, not a run: the enable/capture flow and
the "allow this while you're away" approval card both run with a human right
there, and they must see the very tools they exist to ask about. An
implementation that ORs the venue into the predicate breaks the law's own
prescribed prepare-then-human-sends path — it reported a registered host tool
as "unknown tool in automation" at enable time. Every real firing passes
`presence: "away"` (automations engine, schedules, server), so presence alone
both fails closed and keeps ceremonies working.

Amendments 2026-07-30 (lane D ratifications): the design's `records_*` verbs
ARE the shipped `vendo_apps_data_list/put/delete` — no rename; the names are
referenced inside stored app documents, and invalidating live apps for
cosmetics fails the migration law. `schedule` carries risk `write` (arming
future unattended behavior is a write). `validate` returns findings in its
output, never a tool error. The host product-slug RENAME (applying the
shipped prefix primitive across the extraction estate) is its own post-wave-1
lane — mixed prefixes are worse than none.

## 9. Wave-3 shapes (added 2026-08-01 by the wave-3 orchestrator; frozen)

Everything here implements the 2026-08-01 LOCKED decisions (design spec §8,
§13, §14; wave-3 brief). Same rule as the rest of this file: propose changes
to the wave-3 orchestrator, never diverge locally.

### 9.1 Memberships — asserted, never stored

```ts
// @vendoai/core — type only
export interface Membership {
  org: string;                 // host-issued org id, VERBATIM (it becomes the
                               // workspace owner and the org-app row subject)
  display?: string;            // consumer-voice org name
  teams?: string[];            // host-issued team ids within this org
  admin?: boolean;             // org admin ⇒ implicit owner of every org app
}
```

The auth preset gains a fourth optional seam (`packages/vendo/src/auth-presets/shared.ts`):

```ts
memberships?: (principal: Principal) => Promise<Membership[]>;
```

Keyed on `Principal`, not `Request` — that is what makes it callable for
unattended runs (host server code, same deployment, no session). All five
presets accept it via `HostAuthPresetOptions` and the one
`composeHostAuthPreset` return. `RunContext` gains an additive optional field
`memberships?: Membership[]` (the schema is already `.passthrough()`): the
wire resolves it once per request in `createContextResolver`; the automations
engine and the app-schedules engine each take an optional
`memberships(principal)` config seam and resolve it when building their fire
`RunContext`. Absent field ⇒ no orgs asserted ⇒ `can()` degenerates to
ownership. Memberships are NEVER persisted anywhere; a `kind:"org"` principal
stays refused at the wire.

Amendment 2026-08-02 (wave-3 close, ratified): the auth preset gains a second
optional companion seam, mirroring `memberships` in shape and rationale —

```ts
resolvePerson?: (query: string, asker: Principal) => Promise<ResolvedPerson | null>;
export interface ResolvedPerson { subject: string; display?: string }
```

The `asker` is not optional garnish (amendment 2026-08-02, before the seam was
published): keyed on the query alone, a host CANNOT implement "resolve only
people in the asker's own org" — they are not told who is asking — and the
check proved a signed-in user with zero memberships probing the host's
directory from their own personal app. `memberships` is principal-keyed for
the same reason. The door additionally requires the asker to hold at least one
asserted membership: a person-share implies an org workspace (§9.5), so a
caller in no org can never complete the share the lookup exists for, and
answering them is pure directory exposure. That refusal happens BEFORE the
host's callback is reached.

Vendo holds no directory (the host's identity system IS the org), so it cannot
turn a typed name into a person and must not pretend to. Without this seam the
Share dialog does NOT offer to share with one person at all (team/org sharing
and fork are unaffected); with it, the grant is written for the RESOLVED
subject, never the typed string. The wave-3 blocker this closes: the field
encoded free text verbatim as a subject, so the grant matched nobody — and
because share-implies-promote, the app had already been moved into the team.
The resolve door is owner-gated (an ungated directory lookup is a
user-enumeration oracle), non-viewers are masked, and an unset seam answers
`not-implemented` — deliberately distinct from "no such person". Unlike
`memberships` it is NOT threaded to the automations/schedules engines: it has
no unattended caller. `/status` advertises `namesPeople` only when it is set.

### 9.2 App-access grants — the only rows Vendo stores

Principal encoding (one string, ref-queryable):
`user:<subject>` · `team:<orgId>/<teamId>` · `org:<orgId>`.

```sql
vendo_app_grants (
  id         text primary key,     -- ag_<uuid>
  app_id     text not null,
  org_id     text not null,        -- the org whose workspace holds the app
  principal  text not null,        -- encoding above
  level      text not null,        -- viewer | editor | owner
  created_by text not null,        -- granting subject, for audit
  created_at timestamptz not null default now(),
  unique (app_id, principal)
);
create index on vendo_app_grants (app_id);
```

One row per (app, principal); re-granting updates `level` in place. A
reserved routed collection (the `vendo_effects` pattern — no generic-records
fallback). Amendment 2026-08-02: grant rows MUST carry
`refs { app_id, principal }`, and the §9.2 grammar is validated AT THE DOOR
(`appAccess.grant`), never only in a store's routing layer. Both were found at
wave close: without the refs, `grantsFor`'s ref query could not read back rows
on any generic-record adapter (the hosted door — a share wrote a row and
granted nothing); and with validation living in local SQL only, the identical
malformed request was refused on Postgres and ACCEPTED on the hosted store.
The adapter rule forbids behaviour that differs by which store is wired. Joins `ERASE_TABLES` and `byApp`; deliberately NOT in the
anon-adoption path (ephemeral users cannot hold org grants). Grant writes are
audited with the existing (never-yet-produced) `AuditEvent.kind: "share"`.

### 9.3 `can()` — one function, and where it lives

Amendment 2026-08-01 (lane G, ratified): the TYPES below live in
`packages/core/src/app-access.ts` and are re-exported by the store, because
the apps runtime speaks them and `apps → core` is the only edge the
dependency guard allows (same split as `Check`/`Finding`). `appAccess(store)`
— the implementation — stays in `@vendoai/store`, built over the adapter
door so hosted stores work too.

```ts
// types in @vendoai/core, implementation in @vendoai/store
export type AccessLevel = "viewer" | "editor" | "owner";   // closed, ordered
export type CanThing = { app: AppId } | { path: string };

export interface AppAccess {
  can(ctx: RunContext, level: AccessLevel, thing: CanThing): Promise<boolean>;
  levelFor(ctx: RunContext, appId: AppId): Promise<AccessLevel | null>;
  grant(ctx: RunContext, appId: AppId, principal: string, level: AccessLevel): Promise<void>;
  revoke(ctx: RunContext, appId: AppId, principal: string): Promise<void>;
  list(ctx: RunContext, appId: AppId): Promise<AppGrantRecord[]>;
}
export const appAccess = (store: VendoStore): AppAccess;
```

Resolution = max of: ownership (`vendo_apps.subject === ctx.principal.subject`
⇒ owner) · org-admin (an asserted membership with `admin: true` whose `org`
equals the row subject ⇒ owner) · grant rows matched against
`ctx.memberships` (user / team / org encodings). Memberships come from the
ctx ONLY — `can()` never queries them. `grant`/`revoke` are owner-gated
inside; `list` is viewer-gated. Path variant: `/user/**` → subject ownership
as today; `/orgs/<orgId>/**` → requires an asserted membership in `<orgId>`,
and under `/orgs/<orgId>/apps/<appId>/` the app grant governs
(viewer = read, editor+ = write); `/orgs/<orgId>/policy.json` writes require
`admin: true`. The apps runtime, wire, and MCP door all reach `can()`
through the runtime (`requireOwned` is widened, not duplicated); the
workspace façade calls it for `/orgs` reads and at commit.

Amendment 2026-08-01 (lane G fix round, ratified): `history(appId)` gains the
RunContext — `history(appId, ctx)`. A ctx-less handle has no identity to
check, which is exactly how a viewer could roll the team's app back (the wire
was the only boundary, and it gated on the now-viewer-level `get`). Levels:
`list` = viewer, `undo` = editor, non-viewers masked as `not-found`. An
OPTIONAL ctx was rejected — any caller omitting it would get the ungated
handle back. No host-facing signature changes. The pure half of `can()`
(principal grammar, level ordering, path rules) lives in
`packages/core/src/app-access.ts` with an `appAccessConformance` kit mounted
by BOTH the store implementation and the apps test fixture, so the two can
never drift.

### 9.4 Access posture

An app the caller cannot even view stays `not-found` (existence-masking, as
today). A VIEWER denied an editor action gets the new error code
`forbidden` (added to `VendoErrorCode`, wire-mapped to HTTP 403) — this code
is thrown ONLY when the caller already provably sees the thing, and it is
what the consumer-voice fork offer renders from. Never throw `forbidden` to
a non-viewer.

### 9.5 Org apps and promote

A promoted app's row keeps the `vendo_apps` shape; `subject` becomes the org
id verbatim (same convention as the workspace `owner` column, contract §3.3).
`promote(appId, orgId, ctx)`: requires ownership of the app, an asserted
membership in `orgId`, and the Cloud key (below); flips the row subject,
moves the app's workspace rows `/user/apps/<id>/** → /orgs/<orgId>/apps/<id>/**`
(owner + path rewrite, history follows), writes an `owner` grant for the
promoter, audits an `app-lifecycle` event with new op `"promote"`. Fork of a
visible app requires `can(viewer)` and lands in the forker's `/user` with
fresh ids + `forkedFrom`, grants never travel (structural: own collection,
fresh app id). The Share dialog is promote-if-personal + grant writes
("share implies promote"). The existing `cloud.ts` share/publish (dead
snapshots to the console) is a DIFFERENT verb and stays untouched.

### 9.6 Cloud gating

`createApps` config gains `multiParty?: boolean`, filled at the composition
seam in `server.ts` from `cloudKeyOptions() !== undefined` (adapter-rule
style: env read lives only at the seam). `grant`/`revoke`/`promote` and the
Share dialog's wire routes throw `VendoError("cloud-required")` when unset.
`can()` itself is OSS and never key-conditional — with no key no grant rows
can exist, so it degenerates to ownership. No validate endpoint, no
capability booleans beyond this one seam-filled flag.

### 9.7 Workspace: `/orgs` mounts and the conflict outcome

Owner derivation is a pure function of the path: `/user/**` → the bound
subject (unchanged), `/orgs/<orgId>/**` → `orgId`. The façade opens with a
mount set derived from `ctx.memberships` (org absent from assertions ⇒ mount
absent). Commit policy per mount: `/user` = last-write-wins (today's re-aim
loop); `/orgs` = strict CAS — a lost swap returns
`{ status: "conflict", paths }` (the first construction of the
`CommitResult` conflict branch; nothing throws). Hot-path render regex,
readdir of `/`, the EACCES message, and the erase cascade all widen to
`/orgs`. Erase-by-subject never deletes org-owned rows (the org outlives the
person); erase-by-app matches both anchors.

### 9.8 Served org apps

Org-owned served apps go through an authenticated wire proxy
(`/apps/:appId/serve/**`, modeled on `wire/box.ts` — payload only, no
cookies/auth across the skin) that checks `can(viewer)` against live rows on
EVERY request; `open()` returns the proxy URL for org apps. Personal served
apps keep today's behavior unchanged.

### 9.9 Sponsorship (lane H)

Own routed-collection state, never on the app row (which stays two
independent declarations that would drift):

```ts
// collection "automations:sponsorships", keyed by appId
{ appId, sponsor: string,            // subject
  display?: string,                  // Principal.display captured at enable/
                                     // adopt (amendment 2026-08-01: consumer-
                                     // voice law — summaries and cards never
                                     // show raw subjects when a display was
                                     // asserted; fallback to subject is the
                                     // ratified behavior when none was)
  intentHash: string,                // core intentHash over §7's AppIntent
  status: "active" | "invalidated",
  reason?: "edit" | "departure" | "grants",
  invalidatedAt?: IsoDateTime }
```

Amendment 2026-08-01 (verifier finding 3): a companion ERA MARKER collection
`automations:sponsored` (`{appId, since}`, refs `{app_id}` only — carries NO
subject data, so a subject erase cannot collect it) records that an app
entered the sponsorship era. Marker present + sponsorship row absent (the
erased-sponsor case) fails closed as `departure` — the automation stops and
waits for adoption; it never reverts to the owner. Pre-era rows (no marker)
keep the owner fallback. The erase path writes nothing.

Minted/refreshed at enable time (sponsor = the enabling subject). The
engine's `runContext` resolves the run's principal from the active
sponsorship (fallback: row subject). Fire-time check in `launchRun`:
sponsorship active + sponsor still `can(editor)` (memberships resolved via
the §9.1 engine seam) + `intentHash` matches the current doc — any failure
stops the run BEFORE any tool call and marks the sponsorship invalidated.
Third-party-edit invalidation hooks the `persistEdit` choke point via a new
optional apps-config hook:

```ts
onDocumentEdit?: (previous: AppDocument, next: AppDocument, editor: string) => Promise<void>;
```

(apps runtime calls it after a successful persist; the automations side
implements it — invalidate when `editor !== sponsor`.) The adoption ask is a
card ON THE APP: additive venue state in the open payload (the
`inclient.ts` `venueStateFor` pattern), served only to callers with
`can(editor)`, listing the automation's reads/writes from its declared
surface. Accepting routes through the EXISTING approvals door as the
adopter themselves (approvals stay strictly self-subject), re-mints the
grant set under the adopter, rewrites the sponsorship row. Nothing is
pushed; the first editor+ to accept wins (CAS on the sponsorship row).

### 9.10 Org-admin policy (lane H)

File `/orgs/<orgId>/policy.json`, format tag `vendo/org-policy@1`, shape
`{ format, rules: PolicyRule[] }` reusing the existing `PolicyRule` match
vocabulary with `action` restricted to `"ask" | "block"` — tighten-only by
construction; `"run"` fails parse. (No argument predicates — kill-list A4
stands; the spec's "$10k" example is not expressible in v1 and is NOT being
re-added.) Guard config gains
`orgPolicy?: (ctx: RunContext) => Promise<PolicyRule[]>` (composed at the
server seam: read the policy files of every asserted org through the store,
union the rules). Evaluation is a post-pipeline strictness clamp in
`#checkWithMetadata`, after the away-downgrade and before the breakers:
`final = stricter(draft, orgOutcome)` on the rank `run < ask < block`. This
deliberately binds grant-authorized drafts too ("between host policy and
user approvals") while a host `block`/`ask` can never be loosened (host
policy always wins). `decidedBy` gains member `"org"` (widen `GuardDecision`,
`AuditEvent.decidedBy`, and the pipeline-conformance stage matrix). THE LAW's
call-time gate stays after everything, untouched.
