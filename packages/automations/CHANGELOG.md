# @vendoai/automations

## 0.8.1

### Patch Changes

- f896726: A run row that names no trigger reads back under the default trigger.

  Making an app's triggers a LIST added a required `triggerId` to the persisted
  run record with no read fallback, so every row written before that made
  `runs.list` throw `validation` for the whole app — the surface asking for one
  automation's history got a 400 instead of a gap, and one legacy row took the
  app's entire fire record down with it. The field now defaults to
  `DEFAULT_TRIGGER_ID` on read, exactly as the capture row's `triggerId` beside
  it already did: a row written when an app had one trigger fired that trigger.

  Nothing changes for rows written since. Nothing is rewritten on disk; the
  default applies on read.

- 15f4759: Engine-owned generic rows carry their app ref, so app erase collects them.

  The schedule cursor, the webhook signing secret and the delivery ledger were
  written with no refs at all. The 02-store §5 app-erase cascade collects generic
  rows by `refs @> {app_id}`, so all three outlived the app they belong to — a
  live HMAC secret kept authenticating for an app that no longer existed, and
  `automations:deliveries`, which has no sweep or TTL anywhere, grew one permanent
  row per webhook delivery. Five write sites now carry the ref, including the
  tick's compare-and-swap replacement and the pre-rekey cursor migration.

  Rows already on disk are unaffected in behavior: every read is by row id, so
  nothing that works today stops working. The ref is stamped forward — a live
  schedule cursor gains it on its next tick; a webhook secret gains it on its next
  mint or rotation.

  The package root drops `appIntentOf`, `SPONSORSHIPS` and the `Sponsorship` type.
  Nothing outside this package imported them. `triggerKey` stays exported.

- 022f789: The automations adoption handoff is removed. When an automation's sponsorship
  lapsed — the sponsor left, lost their permissions, or somebody else edited the
  app — the automation stopped and an "adoption card" waited inside the app so the
  next editor could take it on, re-approving its reads and writes as themselves.
  No host used it.

  Sponsorship itself is unchanged: an automation still runs as a named person, and
  still stops when that person's authority lapses. What goes is the second half —
  the handoff to somebody new.

  Gone: `AutomationsEngine.adoption()` and `.adopt()`, the `AdoptionCard` and
  `AdoptionNeed` types (`@vendoai/automations`); `ADOPTION_VENUE_KEY`
  (`@vendoai/core`); `POST /automations/:id/adopt/:triggerId` (`@vendoai/vendo`);
  `client.automations.adopt()`, `<AdoptionCard>`, `<AdoptionVenueCard>`,
  `ADOPTION_VENUE_KEY`, `AdoptionCardProps`, `AdoptionVenue` and `AdoptResult`
  (`@vendoai/ui`).

  Pre-1.0 hard cut, no deprecation shim. A stopped automation is restarted the way
  it was armed in the first place: anyone who can edit the app calls `enable()`
  again, which re-approves its reads and writes under the new sponsor. The stopped
  sentence the run row and the list carry now says "anyone who can edit this app
  can turn it back on" instead of "…can take it on".

- 0039efe: Internal restructuring only — **the public surface is unchanged**. `createAutomationsEngine` was one 1,980-line closure inside a 2,499-line file; it is now a 13-line assembler over 18 modules, each holding one concern (app rows, arming, grants, run rows, the §9.9 sponsorship gate, grant capture, run execution, and the five public-door surfaces). Every helper moved verbatim; the row shapes it persists, the queries it issues and the sentences it writes are byte-identical, and 07 §1's exported `createAutomations`/`AutomationsConfig`/`AutomationsEngine` are untouched. No test file changed.
- Updated dependencies [a7a0fcf]
- Updated dependencies [38b32a3]
- Updated dependencies [e092567]
- Updated dependencies [2fd14aa]
- Updated dependencies [898eb8f]
- Updated dependencies [b99147f]
- Updated dependencies [46923cc]
- Updated dependencies [b50a766]
- Updated dependencies [f25138f]
- Updated dependencies [022f789]
- Updated dependencies [354f231]
- Updated dependencies [ee92750]
- Updated dependencies [d599d23]
- Updated dependencies [a69aa5c]
- Updated dependencies [89660d1]
- Updated dependencies [7163a25]
- Updated dependencies [1022b2f]
- Updated dependencies [2b6d60f]
- Updated dependencies [b99147f]
- Updated dependencies [b99147f]
- Updated dependencies [5e8a141]
- Updated dependencies [8f3d23a]
- Updated dependencies [be9f3e9]
- Updated dependencies [2b49b64]
- Updated dependencies [6fb568a]
- Updated dependencies [2357b22]
  - @vendoai/core@0.8.1
  - @vendoai/apps@0.8.1

## 0.8.0

### Minor Changes

- 21c8b10: **BREAKING:** an automation is now a list of triggers, each armed on its own, and
  a run that meets a permission nobody granted fails LOUDLY instead of waiting.

  An app used to be one automation with one trigger, so consent, sponsorship,
  schedule cursors and runs could all be keyed to the app — arming it once
  authorized everything it might ever fire. They are keyed to (app, trigger) now:
  `enable(appId, triggerId, ctx)` and `disable(appId, triggerId, ctx)` arm exactly
  one trigger, `list(ctx)` answers with each app's trigger LIST (armed state,
  sponsor, pending grants and stopped reason per trigger), and `dryRun`/`adopt`
  take the trigger too. The waiting state is gone with it: there is no
  `"pending-approval"` run and no parked run to resume, because a parked run held
  an approval, an identity and an intent open across an unbounded gap that nobody
  could see the end of. A run that needs a permission it does not hold ends as
  `error` with code `needs-permission`, naming the tool or service it needed, and
  `runs.rerun(runId, ctx)` fires the same trigger again on the same event once the
  permission is allowed — a fresh run, against live data, with the guard's effect
  ledger keeping the work the first attempt already landed from happening twice.

  - `RunStatus` no longer has `"pending-approval"`; a status filter that passes it
    is now a validation error.
  - `enable`, `disable`, `dryRun`, `adopt` take a `triggerId`; `list` returns
    `triggers[]` per app rather than one trigger's state on the app.
  - `runs.list` accepts a `triggerId` filter; `runs.rerun` is new.
  - The parked-run collection and its resume path are removed.

- 8d623ec: Connector discovery uses the broker's own search; execution stays ours.

  `search_connectors` searched a local keyword index and then EXPANDED a matching
  toolkit server-side, expecting the client to re-list via
  `notifications/tools/list_changed`. Measured live, Claude Code's agent SDK
  registers no list-changed handler for an HTTP MCP server — exactly one
  `tools/list` per session — so a tool the model had just found was uncallable for
  the rest of that session. The shape is one the industry has abandoned (GitHub
  removed `--dynamic-toolsets`; Composio, whose catalog this is, never shipped it).

  Three permanent tools replace it, so the listing never changes and callability
  never depends on a re-list. They are ordinary registry tools, so they work on
  both the `vendo()` and `claudeCode()` harness paths:

  - **`find_service_tools(need)`** — the connector's OWN search. Each match
    carries the callable slug, the full input schema, the caller's connection
    status and the broker's next-step message, inline, so the model can construct
    a call with no second lookup. A match the broker has no schema for says so
    rather than inviting a guess. The answer is bounded by its own SERIALIZED
    size, under the turn's `agent.toolOutputCap`, so it can never be the result
    that cap truncates: broker schemas are kilobytes each (Composio's run 5–7KB),
    and a result cut at a character count loses a schema mid-object with nothing
    saying which match lost it. Matches are included whole, in the broker's
    relevance order, until the budget is spent; whatever is left over is reported
    as `moreMatches` (a count) and `moreMatchesNote` (narrow the `need` and search
    again), never dropped silently. A single schema larger than the whole budget
    still returns its row, with the same `schemaUnavailable` marker that already
    sends the model to ask rather than guess.
  - **`use_service_tool(slug, arguments)`** — looks up the broker's per-tool risk
    tag, maps it to a `RiskLabel`, lets the guard decide run/ask/refuse, executes,
    and lands on the audit trail with its toolkit named — the same guarded path a
    `host_*` call travels. An untagged tool is `ungraded` (ask-by-default); risk is
    never inferred from a tool's name.
  - **`list_connections`** — unchanged, re-backed by the connector's connection API.

  The Composio adapter also trims the documentation Composio ships for PEOPLE
  inside the machine schema — `examples`, `human_parameter_name`,
  `human_parameter_description` — before a schema reaches the model. It is a third
  of the bytes and none of it is needed to construct a call (measured against
  their live catalog 2026-08-03: eight email matches, 36,407 chars whole, 24,736
  trimmed), so trimming is what lets a realistic search come back complete instead
  of short. Only KEYWORDS are removed: a parameter named `examples` is an
  argument, and survives.

  Both new tools exist only when a connector adapter can actually serve them
  ("no adapter, no tool"): `find_service_tools` and `use_service_tool` need a
  connector implementing the new capabilities, `list_connections` needs only a
  configured connector.

  **The Composio adapter's tool plane now speaks one API version, so a tool the
  search finds is a tool that runs.** Discovery is Composio's tool-router, which
  exists only at `v3.1`; execution and the `apps`-scoped listing were still on
  `v3`. Those are two different catalogs, not two doors onto one — so the model
  would find a slug and the executor would answer `Tool <SLUG> not found`, an
  opaque connector error rather than a connect card or a hint to search again.
  Live-measured against their catalog 2026-08-03, 19 of the 42 slugs a `v3.1`
  search returned for eight ordinary needs did not exist on `v3` at all: every
  Outlook mail and calendar action (`OUTLOOK_SEND_EMAIL`, `OUTLOOK_CREATE_DRAFT`,
  `OUTLOOK_SEND_DRAFT`, `OUTLOOK_CALENDAR_CREATE_EVENT`), every `COMPOSIO_SEARCH_*`,
  five `TEXT_TO_PDF_*`, `GOOGLECALENDAR_EVENTS_GET` and
  `WEATHERMAP_GEOCODE_LOCATION`. It only stayed hidden because Gmail and Slack
  happen to exist in both. Connector tools that used to fail now run.

  The skew ran the other way too, so the listing moved with the executor: `v3`
  carries legacy names `v3.1` has renamed (`OUTLOOK_OUTLOOK_CREATE_DRAFT`,
  `COMPOSIO_SEARCH_NEWS_SEARCH`), and a `v3` listing feeding a `v3.1` executor
  breaks identically. An `apps`-scoped host therefore sees the larger, current
  `v3.1` catalog — Gmail goes from 23 tools to 63, Outlook from 43 to 305 — and
  more of those tools arrive `ungraded`, which is ask-by-default.

  Connected accounts and auth configs stay on `v3` deliberately: live-verified
  identical on both versions, and that plane has no catalog to skew against.
  Both versions are named in one constant each at the top of the adapter.

  **Removed public surface.** All of it existed to serve lazy expansion:

  - `@vendoai/core`: `ToolListingContext.listingScope` and
    `ToolRegistry.releaseListingScope`. A listing no longer has to be identified —
    every tool a run may call is on every listing that run is given.
  - `@vendoai/actions`: `Connector.discoveryIndex`, `Connector.expandToolkits`,
    the `ToolkitIndexEntry` type, `ActionsRegistry.expandToolkits`, the `ctx`
    parameter of `ActionsRegistry.search`/`loadoutSeed`, and
    `ToolSearchOptions.maxExpansions`. `ActionsRegistry.loadoutSeed` now answers
    with every loaded tool and ignores its `connectedToolkits` argument: the
    argument only ever filtered lazily expanded connector tools, and there are
    none. New in their place, all optional:
    `Connector.searchTools`, `Connector.toolRisk`, `Connector.executeSlug`, and the
    `ServiceToolMatch` type. `Connector.toolkitOf` is unchanged — the pre-guard
    connect check still rides it.
  - `@vendoai/agent`: `CONNECTOR_DISCOVERY_TOOLS` now names the three tools above;
    the discovery registry's ports changed shape with them.
  - `@vendoai/mcp`: the door no longer advertises `tools.listChanged`, no longer
    diffs its listing around a call, and no longer keeps a per-session
    notification-replay flag.
  - `@vendoai/vendo`: the `maxSearchExpansions` handler option.

  **Known gap, deliberately not papered over.** A connector that cannot search
  gets neither new tool, and the zero-key Vendo Cloud connector has no search
  backend today — so a Cloud-default deployment that does not scope
  `connectorApps` reaches connectors through the connect dock only until the
  console broker exposes a search endpoint. Filling that with keyword scoring or
  name-based risk inference is exactly what this change removes.

  **Automations can run connector tools, through the consent they already use.**
  `use_service_tool` is one tool name standing in for the broker's whole catalog,
  so its descriptor cannot carry a real grade — it is `ungraded`, and design §12
  withholds `ungraded` from an unattended run the same way it withholds
  `destructive`. Left there, arming an automation on a connector would have been a
  narrowing: before this wave an individually-graded `read` connector tool WAS
  offered to an automation.

  The fix reuses declare-then-accrete consent rather than inventing a mechanism.
  An automation's steps declare the service actions they will call; the person
  arming it approves those specific actions, in the enable card they already see;
  the unattended run may then call exactly those slugs.

  - **`@vendoai/core`**: `GrantScope` gains a third member,
    `{ kind: "service-tool", slug }` — the missing middle between "this whole
    tool" (twenty thousand actions on this one name) and "this exact payload"
    (useless on the next run). Plus `USE_SERVICE_TOOL`, `serviceToolSlug`,
    `serviceToolPhrase`, `withResolvedRisk`, and `RiskResolver` (moved here from
    `@vendoai/guard`, which re-exports it unchanged).
  - **`@vendoai/guard`**: a `service-tool` grant matches a call by its slug.
    `tool` and `exact` grants are untouched, and nothing attended mints the new
    scope, so chat behaviour is unchanged.
  - **`@vendoai/automations`**: `AutomationsConfig.resolveRisk` — the SAME
    resolver the composition gives the guard. Arm-time capture grades a declared
    connector call with it, so the consent card states the grade the call will
    really run under and the grant it mints carries the descriptor hash the guard
    recomputes at fire time. Capture is per service action, and its consent
    sentence names the action in a person's words ("Allow "Morning digest" to
    fetch emails in Gmail while you're away").
  - **`@vendoai/ui`**: a consent row for a connector permission reads as its
    service action with the service's own logo, instead of "Use an outside
    service" once per row.

  What did NOT change: §12 still withholds the dispatcher from every unattended
  listing, and a granted service action the broker grades `destructive` is still
  refused away — the same answer a granted `host_*` send has always got.

  **Second known limit.** An agentic automation declares no slug, so it captures
  no connector grant at arm time: its connector calls park at fire time and
  accrete a per-slug grant when a person approves them. The alternative would have
  been a tool-wide grant on the dispatcher, which is the whole catalog behind one
  card.

- 2ed91b0: **BREAKING:** the pack concept is gone. Capability arrives on `tools` and
  `skills`, and app generation and automations mount themselves.

  A pack was a labelled bundle of four lists, and every one of those lists already
  had a home of its own: tools → the one registry, skills → the workspace mount,
  checks → the checking floor, components → the catalog. The label bought a noun,
  a `definePack` handle, a provider function shape, a client-side second import,
  and a default list — and nothing else. A developer should never have to learn
  it; they already know "tools" and "skills".

  - `createVendo({ packs })` is removed. `tools:` now takes executable
    `ToolDefinition` entries alongside the `vendo sync` declarations it already
    took (told apart by `execute`), and `skills:` is new — SKILL.md values mounted
    at `/host/skills`. Checks keep arriving through `apps.checks` and components
    through `catalog`, exactly as a host already writes them.
  - `definePack`, `PackProvider` and `Pack` are removed; `PackSkill` is renamed
    `Skill` and kept as a deprecated alias for one release. `<VendoRoot packs>` is
    removed — components were always passable through `components` directly.
  - The boot-time collision check survives verbatim in the composition merge: two
    contributors claiming one tool or skill name is still an error at boot that
    names both, and a contributor claiming one of the host's own extracted tool
    names still refuses to compose.
  - New: `apps: false` unmounts app generation (`vendo_make`, the `vendo_apps_*`
    tools, the `building-apps` skill and the `/apps` wire surface are absent, not
    refusing), and `automations: false` unmounts automations (`/automations`,
    `/runs` and `/webhooks` answer not-found, `vendo.emit` refuses, nothing fires,
    and THE LAW's unattended-irreversibility rule leaves the reviewer's rubric).
    Both mount by default.
  - `@vendoai/automations` now exports `UNATTENDED_IRREVERSIBILITY_RULE` and
    `unattendedIrreversibilityCheck` — the rule moved to the block whose law it is.
    It joins the reviewer's rubric by default now that it rides the subsystem
    rather than an opt-in pack.

  A default `createVendo()` composes exactly the tool set and skill set it did
  before, asserted against literal lists in `default-composition.test.ts`.

- d0c3cc9: Risk grading stops guessing from tool names, and a tool nobody has graded now
  says so out loud instead of running.

  **The word lists are gone.** Extraction used to read a tool's name against
  `DESTRUCTIVE_WORDS` / `READ_WORDS` (and Composio slug verbs) to pick a grade.
  English is infinite, so that list was guaranteed to miss — _pay, charge,
  refund, approve, merge, publish_ were never on it — and its existence is what
  stopped anyone from auditing the labels. No code path concludes anything from
  a tool's name anymore.

  **Only facts grade a tool**, in priority order: a human (`overrides.json`), the
  AI judge (which reads the handler source and quotes its evidence), then
  protocol facts that are true by definition — HTTP `DELETE` is `destructive`, a
  declared GraphQL/tRPC `mutation` is at least `write`, and Composio's own
  `destructiveHint`/`readOnlyHint` say what they say. A `GET` is **not** a fact
  about reading (GETs that mutate exist) and a `POST` is not a fact about
  writing (search endpoints post).

  **⚠️ Breaking behavior: an unjudged catalog now asks on mutations.** Anything
  nothing above graded is the new first-class `ungraded` risk state, and the
  guard's default treatment is to ask — like `destructive`, and at the guard
  level rather than as an init-written rule, so a hand-wired server with no
  policy config at all gets it too. On an install that never ran the AI judge
  this is a real change: tools that used to run silently now park on an approval.
  That is the point — `payInvoice` classified `write` and ran un-gated. Three
  ways forward, and every one of them is a sentence:

  - run `vendo sync` with a model key so the judge grades the catalog;
  - grade the tools you care about by hand in `.vendo/overrides.json`;
  - or decide, in writing, that you accept them:
    `{ "match": { "risk": "ungraded" }, "action": "run" }`.

  `vendo doctor` reports the count plainly (`catalog: 34/61 tools ungraded`,
  code `E-TOOLS-003`), and a keyless `vendo init`/`vendo sync` says what the
  consequence is instead of implying the grades are real.

  **`critical` is now `confirmEach`.** Behavior is unchanged — checked before
  rules, grants, and the judge; none of them can suppress it; every call earns
  its own input-bound, single-use approval. The old name read as a severity rung
  and it is not one: the grade is a _fact_ about the action (a payment is a
  `write`), while `confirmEach` is _governance_ — who must be present. They are
  orthogonal, which is why a data export can be `read` + `confirmEach` and a bulk
  archive can be `destructive` without it. Host-authored files
  (`overrides.json`, `judgments.json`, `.vendo/tools.json`) accept `critical:` as
  a read alias indefinitely; every writer emits `confirmEach`. In TypeScript,
  `ToolDescriptor.critical` becomes `ToolDescriptor.confirmEach` and
  `decidedBy: "critical"` becomes `decidedBy: "confirmEach"`.

  **A standing denial means a person said no.** An ask that re-issues the same
  call id is answered by the user's earlier no instead of minting a new card — but
  only when a _human_ wrote it: an abandoned chat turn, a timed-out embed, and the
  TTL sweep reap the pending row and let the next issue ask again. A person's no
  also voids any unconsumed yes still sitting on the same call, and a decision can
  be taken back with `guard.approvals.revoke(id, principal)` / `DELETE
/approvals/:id` (the mirror of `grants.revoke`). Taking a decision back and
  replaying an approval are the same one-time transition, so a call can never both
  run and be voided — a take-back that arrives after the call was already
  authorized answers `conflict` rather than reporting success. `Guard` grows one
  optional method for the block that spends a yes WITHOUT replaying its call
  (automations arms a standing grant from it): `spendApproval(id, principal)`
  contends on that same transition and answers `spent` / `already-spent` /
  `taken-back`. Custom Guards are unaffected — callers feature-detect it, exactly
  like `abandonApprovals`.

  Three known limits, all written down at the code that carries them. The receipt
  is the only atomic step: an approval ROW has no guarded write (the store offers
  `atomic` for threads, apps and generic rows only), so every marker on it is a
  read followed by a write and something can move the row in between. Because the
  transition winner is settled before any row write, the worst that costs you is a
  stale marker — never an execution, since the transition a call would need is
  already spent. And a custom `Guard` that does not implement the optional
  `spendApproval` puts the automations grant mint back on that read-then-write
  footing, where a revoke landing in the window can lose to the mint; the guard
  that ships here has the seam. Third: when an automation's parked run resumes, its
  standing grant is written just before the call and taken back if the call is not
  authorized after all — every outcome the process lives through, a thrown one
  included, but a hard kill in between leaves that grant behind and nothing sweeps
  it. It shows up in `grants.list`, pinned to the tool's `descriptorHash`,
  app-bound and away-only, and you can revoke it.

  One consequence worth knowing: `descriptorHash` follows the field rename, so
  approvals and grants persisted before the upgrade no longer match their tool's
  new hash. They lapse into a re-ask, which is the fail-closed direction.

### Patch Changes

- Updated dependencies [2e792a1]
- Updated dependencies [963d980]
- Updated dependencies [b022eb3]
- Updated dependencies [1572060]
- Updated dependencies [a004031]
- Updated dependencies [21c8b10]
- Updated dependencies [3f98372]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [10a2b44]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [d6f5e28]
- Updated dependencies [56e0cc3]
- Updated dependencies [a004031]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [6eb8a04]
- Updated dependencies [fbf265b]
- Updated dependencies [ce98c54]
- Updated dependencies [2ed91b0]
- Updated dependencies [e6aaa7a]
- Updated dependencies [ab5d181]
- Updated dependencies [d0c3cc9]
- Updated dependencies [0197470]
- Updated dependencies [798b618]
- Updated dependencies [8132329]
- Updated dependencies [10a2b44]
- Updated dependencies [d1ff923]
- Updated dependencies [98eba22]
- Updated dependencies [f7c6da2]
- Updated dependencies [14e8246]
- Updated dependencies [6a3d9e3]
- Updated dependencies [fbf265b]
- Updated dependencies [38a840d]
- Updated dependencies [a0dbfc6]
- Updated dependencies [39a7ecc]
  - @vendoai/core@0.8.0
  - @vendoai/apps@0.8.0

## 0.7.0

### Patch Changes

- e56ed30: Cloud-audit small fixes: five places where the runtime and what it claims had
  drifted apart.

  **The hosted session sweep now rides the authenticated tick.** Both existing
  cadences are unreachable on a serverless host — the unref'd interval timer
  never fires, and the amortized on-request sweep is gated by a per-process
  `lastSweepAt` that a per-request process re-seeds every invocation. A
  deployment on the hosted store leaked idle anonymous sessions forever.
  `POST /api/vendo/tick` now runs the same sweep the other two cadences call
  (hosted stores only; a local composition already has both). Two cadences
  firing at once is safe — the claim leg is a single-winner election
  server-side.

  **`E2B_API_KEY` without the `e2b` package is now a loud misconfig.**
  `createVendo` used to silently demote a half-configured BYO sandbox to Cloud,
  or to the dark venue with no key at all, so the operator found out at the
  first server-app build. It now throws with the exact fix. An explicitly
  passed `sandbox:` adapter still wins before any env check.

  **`fn:` steps deferred to Cloud now warn.** Enabling an automation whose
  schedule or external trigger fires on Cloud, with `fn:` steps in it, warns
  once naming the app: `fn:` runs in the app's own sandbox machine, which the
  Cloud runner may not be able to wake or reach in v1. The docs claimed this
  warning existed and described `fn:` as a callback into the host process —
  both wrong, both fixed.

  **Two honesty fixes to operator copy.** `vendo doctor` no longer offers a
  "managed MCP broker" no code path wires from a key; it names the adapter slots
  a key actually defaults. And the hosted-session-doors warning no longer blames
  a vendo-web commit for a surface the console restored on 2026-07-20 — it
  reports what the client observed (a bare 404) instead.

- Updated dependencies [8f5a7c0]
  - @vendoai/core@0.7.0
  - @vendoai/apps@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [a2bd192]
  - @vendoai/apps@0.6.1
  - @vendoai/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
- Updated dependencies [a7199db]
  - @vendoai/core@0.6.0
  - @vendoai/apps@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [0b58e3e]
- Updated dependencies [0e3bc0a]
- Updated dependencies [f965d77]
- Updated dependencies [cbffc9e]
- Updated dependencies [c7277f6]
- Updated dependencies [da9d4a9]
- Updated dependencies [f5fbb4b]
- Updated dependencies [221b851]
- Updated dependencies [f95feb7]
- Updated dependencies [d1364b6]
- Updated dependencies [280a142]
  - @vendoai/apps@0.5.0
  - @vendoai/core@0.5.0

## 0.4.8

### Patch Changes

- Updated dependencies [9f01a92]
  - @vendoai/apps@0.4.8
  - @vendoai/core@0.4.8

## 0.4.7

### Patch Changes

- Updated dependencies [fd9260d]
  - @vendoai/apps@0.4.7
  - @vendoai/core@0.4.7

## 0.4.6

### Patch Changes

- Updated dependencies [60c5e39]
  - @vendoai/apps@0.4.6
  - @vendoai/core@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [31f899e]
- Updated dependencies [87eadba]
  - @vendoai/core@0.4.5
  - @vendoai/apps@0.4.5

## 0.4.4

### Patch Changes

- 835d17a: Edge-runtime portability: the server entry now bundles and boots on
  Web-standard runtimes (Cloudflare Workers first). Fetch defaults are
  invocation-safe, the optional e2b SDK no longer breaks esbuild/Wrangler
  builds, Node-only legs (local store engines, dev model ladder, telemetry
  disk config, actions sync tooling) sit behind worker/edge export
  conditions with honest guidance, and createVendo performs no I/O, timers,
  or random generation at construction — module-scope wiring works. A CI
  portability gate (bundle + real workerd boot) keeps it that way.

  Note for hosts that reach into composed blocks directly: the BYO tool seam
  (`vendo.guardedTools`, and the ai-sdk/mastra packs built on it) arms schema
  readiness on first execute. Raw `vendo.store`/`vendo.automations` reach-ins
  should `await vendo.store.ensureSchema()` first — the previous eager kick
  only ever gave that pattern a racy head start.

- Updated dependencies [835d17a]
  - @vendoai/core@0.4.4
  - @vendoai/apps@0.4.4

## 0.4.3

### Patch Changes

- Updated dependencies [a48b1b7]
  - @vendoai/apps@0.4.3
  - @vendoai/core@0.4.3

## 0.4.2

### Patch Changes

- @vendoai/core@0.4.2
- @vendoai/apps@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [b7a860f]
  - @vendoai/core@0.4.1
  - @vendoai/apps@0.4.1

## 0.4.0

### Minor Changes

- 0032a67: Add optional atomic record claims and revision CAS, use them to deduplicate multi-instance automation firing, and abort in-process agentic runs when stopped.

### Patch Changes

- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- dab84c2: Performance: bound the automations tick and the agent's per-turn context.

  - **automations**: the tick fetches only schedule-triggered apps through an indexed
    `trigger_kind` ref (was a full scan of every app for every subject) and batches every
    schedule cursor into one query (was an N+1 get per app). Fired automations now execute
    with bounded parallelism (`tickConcurrency`, default 4) and an optional per-run timeout
    (`runTimeoutMs`), so one hung run cannot block other tenants or overrun the tick
    interval. `emit` likewise fetches only the subject's host-event apps. `/tick` still
    returns the same runIds.
  - **agent**: Anthropic prompt-caching breakpoints on the static system prompt and the
    stable history prefix (ignored by other providers); a default tool-output cap so one
    huge host-tool response cannot blow the context (`config.agent.toolOutputCap`); a new
    `historyWindow` knob bounding what is re-sent per turn (default: the full thread, as
    before); and thread listing that derives titles from a stored `title` instead of loading
    every thread's full message array.
  - **store**: btree indexes backing the `(created_at, id)` keyset pagination on
    `vendo_records` and the paged MCP tables, a generated `trigger_kind` column on
    `vendo_apps`, and a `title` column on `vendo_threads`. All applied as additive DDL — no
    schema-version bump and no data migration.

- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.
- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [023b3c0]
- Updated dependencies [fa0ad98]
- Updated dependencies [0e94fa6]
- Updated dependencies [7826a6e]
- Updated dependencies [7546de1]
- Updated dependencies [51f3fc9]
- Updated dependencies [dab84c2]
- Updated dependencies [ff6b5d5]
- Updated dependencies [8d5423d]
  - @vendoai/core@0.4.0
  - @vendoai/apps@0.4.0
