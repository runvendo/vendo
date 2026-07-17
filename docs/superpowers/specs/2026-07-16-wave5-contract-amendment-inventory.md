# Wave 5 contract-amendment inventory — agent loop robustness + seam fixes (ENG-238)

> **STATUS: PARKED for Yousef.** Contracts are frozen; nothing under
> `docs/contracts/` was edited. Each item below records where wave-5 reality
> now diverges from (or extends) the frozen text, quoting the current text and
> the amendment the shipped code needs. Items marked *no amendment needed*
> are places where the code caught up to what the contract already mandates —
> listed for the record so the diff is explainable.

Shipped surface being described: cancellation + step cap + guard-side
approval abandonment in `packages/agent` / `packages/guard`, RunContext
promotion + wire-envelope/step-limit parts + open enums + byte caps + CJS
condition in `packages/core`, and prompt wiring + runtime store exports in
`packages/vendo`.

## 01-core.md

### Item 1 — §3 RunContext: `grant` and `mcpConsent` become first-class optional fields (CORE-2)

- **Current text:** `RunContext` lists `principal, venue, presence, sessionId,
  appId?, trigger?, requestHeaders?, actor?` only. The guard's grant
  attachment and the MCP door's consent projection ride through
  `.passthrough()` as undeclared structural twins
  (`ActionsRunContext`, `McpRunContext`).
- **Needed change:** add `grant?: PermissionGrant` (the exact grant behind an
  away execution, attached by guard) and `mcpConsent?: McpConsent` with
  `interface McpConsent { clientId: string; scopes: string[] }` (the door's
  OAuth-consent projection, 10-mcp §3). Note that downstream twins are
  deleted: `ActionsRunContext` is now a bare alias, `McpRunContext` narrows
  `mcpConsent` to required.
- **Why:** the fields were load-bearing in three packages while undefined in
  core (CORE-2 maj); promoting them makes the seam typed and single-sourced.

### Item 2 — §6 Guard: optional `abandonApprovals` (AGENT-6)

- **Current text:** `Guard` has exactly `check / report / directions /
  onApprovalDecision`.
- **Needed change:** add optional
  `abandonApprovals?(ids: ApprovalId[], ctx: RunContext): Promise<void>` —
  resolve approvals the conversation abandoned (a fresh user turn superseded
  an undecided ask): deny, subject-scoped, idempotent, never minting a grant.
  `@vendoai/guard` implements it through the same locked decide path as an
  explicit denial (audit + decision callbacks).
- **Why:** abandoned approvals previously sat pending forever guard-side while
  the thread already showed them abandoned (AGENT-6 min).

### Item 3 — §16 stream parts: the nested wire envelope (AGENT-10)

- **Current text:** §16 declares `VendoViewPart` / `VendoApprovalPart` /
  `VendoConnectPart` as FLAT `{ type, ...fields }` shapes.
- **Needed change:** document the wire/persisted envelope the ai-SDK data
  channel actually carries — `{ type, data: { ...fields }, id? }` — as the
  normative wire form, with the flat shapes as the logical parts. Core now
  ships `VendoWirePart<Part>`, `toVendoWirePart()`, and
  `vendo*WirePartSchema` pairings (additive; flat shapes unchanged;
  `packages/ui`'s tolerant reads already accept both).
- **Why:** every persisted thread and SSE stream nests under `data`; the
  contract's flat form was never what crossed the wire (AGENT-10 min).

### Item 4 — §16 stream parts: `VendoStepLimitPart` (AGENT-7)

- **Current text:** §16 lists view/approval/connect parts only.
- **Needed change:** add
  `interface VendoStepLimitPart { type: "data-vendo-step-limit"; limit: number; message: string }`
  — streamed when the agent loop stops because it exhausted its step cap.
  Additive under §15 (unknown parts are ignored).
- **Why:** the previously silent hardcoded 20-step stop is now visible in the
  stream, per the wave-5 scope decision.

### Item 5 — §4 named tool-namespace constants (AGENT-4)

- **Current text:** no named constant; the `vendo_apps_` coupling existed only
  as string literals in agent and apps.
- **Needed change:** document `VENDO_APPS_TOOL_PREFIX = "vendo_apps_"` and
  `VENDO_APPS_CREATE_TOOL = "vendo_apps_create"` as core exports: tools under
  the prefix are the only ones whose ok-outcome may carry an OpenSurface onto
  the view channel; the create tool is the streaming-view bridge target.
- **Why:** the agent↔apps coupling is now a named core seam instead of two
  packages string-matching each other.

### Item 6 — §15 open enums (CORE-11) — *code caught up; small clarifying note optional*

- **Current text:** §15's forward-compat paragraph already mandates tolerating
  unknown codes/kinds/variants; the shipped zod schemas contradicted it with
  closed enums.
- **Needed change:** none strictly; optionally note that
  `vendoErrorCodeSchema`, trigger kinds (`triggerRefSchema` /
  `triggerSourceSchema`), and run models now PARSE unknown variants while
  known variants keep strict shapes (TS unions stay closed on known members).
- **Why:** parse-time rejection of future variants broke the additive version
  train the section itself pins.

### Item 7 — §8 byte caps (CORE-6) and fn: action grammar (CORE-5) — *code caught up*

- **Current text:** "64 KB per component source / 256 KB total" and "anywhere
  a tree names a callable — `TreeQuery.tool` or an action name — the form
  `fn:<name>` …".
- **Needed change:** none to the normative text. For the record: caps are now
  measured in UTF-8 bytes (`TREE_MAX_COMPONENT_SOURCE_BYTES` /
  `TREE_MAX_TOTAL_COMPONENT_BYTES`; the `*_CHARS` exports remain as
  deprecated same-value aliases), and `validateTree` now enforces the fn:
  grammar on action names in node props (machine-presence stays with
  `validateAppDocument`, which knows `server` — the §8 ESCALATION stands for
  that half only).
- **Why:** UTF-16 measurement admitted up-to-3x oversized payloads; the action
  half of the grammar was enforceable on the wire but wasn't.

### Item 8 — packaging: CJS export condition (CORE-10)

- **Current text:** 01/00 describe core as a single-entry ESM package (plus
  the `/conformance` subpath).
- **Needed change:** note the additive `require` condition on both subpaths
  (`dist/cjs`, `{ "type": "commonjs" }` marker), ESM remaining the primary
  `default` condition. The platform-clean guarantee (no `node:` imports)
  holds for both legs.
- **Why:** CJS hosts on Node without `require(esm)` (< 20.19) could not load
  core at all.

## 03-agent.md

### Item 9 — §1 `VendoAgent.stream` gains `signal?: AbortSignal` (AGENT-3)

- **Current text:** `stream(input: { threadId?, message, ctx })`.
- **Needed change:** add optional `signal?: AbortSignal` — cancels the turn:
  the in-flight provider call aborts, no further step starts, an
  already-aborted signal never reaches the provider, and the thread persists
  consistent + resumable. The umbrella wires `request.signal` from
  `POST /threads`, so client disconnect cancels the loop.
- **Why:** no cancellation path existed anywhere in the block (AGENT-3 maj).

### Item 10 — agent context config: `maxSteps` (AGENT-7)

- **Current text:** the agent's context knobs (as amended for ENG-237/309)
  don't include a step cap; the 20-step stop was hardcoded and silent.
- **Needed change:** document `context.maxSteps` (default 20, positive
  integer) and the `data-vendo-step-limit` exhaustion part (Item 4).
  09-vendo §2 correspondingly gains `agent.maxSteps` on `CreateVendoConfig`.
- **Why:** the cap is host-tunable now and exhaustion is client-visible.

### Item 11 — §3 item (4) catalog+theme assembly is real (AGENT-1/2) — *mostly code catching up*

- **Current text:** "(4) catalog + theme summary when the venue can render
  trees" — previously assembled by nobody; `system.product` (the host brief)
  was never fed either.
- **Needed change:** none to the five-item list itself. Note the mechanism:
  the umbrella reads `.vendo/brief.md` into `system.product` and assembles
  the summary (`catalogThemeSummary`) into a new `system.catalog` config
  field; the agent injects it between directions and host instructions for
  venues `chat` and `app` only. If §1's config shape is quoted anywhere, it
  gains `system.catalog?: string`.
- **Why:** prompt.ts claimed the umbrella folds it in; now it actually does.

### Item 12 — client message-upsert semantics (AGENT-12)

- **Current text:** no normative statement about what a client may upsert;
  the door accepted any same-id replacement (subject-scoped only).
- **Needed change:** state the rule the agent now enforces: a NEW message id
  must be role `user`; an existing user message may only be re-sent
  identically; an existing assistant message may change only by flipping
  parts `approval-requested → approval-responded` (same type, toolCallId,
  toolName, input, and native approval id; boolean verdict). Everything else
  is a `validation` error.
- **Why:** clients could inject or rewrite assistant content by replaying a
  known message id (AGENT-12 min).

## 09-vendo.md

### Item 13 — §2 umbrella runtime store surface (XCUT-3)

- **Current text:** the umbrella's server surface lists `createVendo` /
  `nextVendoHandler` (+ the wave-3 `eraseStore` re-export); the deploy doc
  showed `createStore({ url })` with no importable path.
- **Needed change:** `@vendoai/vendo/server` (and the `vendoai/server` alias)
  re-export `createStore`, `envSecrets`, `storeSecrets`, `secretStore` so the
  documented production-deploy path is reachable from the umbrella alone.
  `docs/persistence-and-deploy.md` now shows the import; the contract's
  surface list should gain these four names.
- **Why:** the production-deploy path was unreachable without installing
  `@vendoai/store` directly, which the packaging story says hosts never do
  (XCUT-3 maj).
