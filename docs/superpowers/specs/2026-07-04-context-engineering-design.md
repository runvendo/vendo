# Context Engineering: Shared Prompt Core + Voice Quality — Design

**Date:** 2026-07-04 (v2 after dual Codex review — 14 findings triaged, all accepted)
**Status:** Approved by Yousef section-by-section; v2 folds in the review fixes
**Scope:** Platform-level. Ships in `@flowlet/core`, `@flowlet/runtime`, `@flowlet/next`,
`@flowlet/react`, `@flowlet/shell`; demo-bank is the first consumer.

## Problem

Chat and voice agents get wildly asymmetric context. Chat runs on a ~200-line engineered
prompt (`apps/demo-bank/src/flowlet/agent.ts` `buildInstructions()`): identity, render-vs-talk
heuristics, brand guidance generated from sandbox tokens, the full genui format guide including
the refreshable-views `queries` protocol, live component catalogs, novel-codegen rules, connect
protocol, automations. Voice runs on ~10 sentences (`voice-realtime.ts` `INSTRUCTIONS` + the
driver's `protocolInstructions()`), knows none of the genui protocol, and phrases its few
overlapping rules in words that drift independently from chat's. A third prompt —
`@flowlet/next`'s default `buildInstructions()` (`packages/flowlet-next/src/agent.ts`) —
duplicates render/refresh/connect guidance and drifts from both.

Audited consequences:

1. Voice-built views (`show_table` / `show_key_value`) are frozen snapshots — no `queries`,
   so pinned voice views never refresh.
2. No shared prompt source — three prompts restate the same rules and drift.
3. Voice carry-over is a 2KB text-only tail (last 16 text turns) — no view awareness, no tool
   results, no saved-flowlet awareness.
4. Voice show-vs-say guidance is one sentence; failure modes (Connect-card-vs-tools wobble)
   were patched case by case.
5. Raw tool outputs enter sessions untruncated — server-side Composio (huge Gmail bodies),
   but also client-executed host tools feeding chat (`packages/flowlet-react` provider) and
   the voice driver sending raw JSON to the realtime session.
6. Voice yaps; register (concise, warm, helpful) is nowhere guaranteed.
7. "What can you do?" gets improvised answers not grounded in the live (dynamic) toolset.

## Decisions locked

- **Architecture:** prompt-fragment catalog — named, parameterized section builders with
  modality variants — over one-canonical-prompt-compressed and shared-constants.
- **Home:** `@flowlet/core`, as a *pure* prompt module: builders take every input as a
  parameter (strings, flags, lists) and import nothing from runtime/components/shell.
  Catalogs, tool summaries, and brand guidance arrive as pre-rendered strings from the
  packages that own them (runtime/next/shell/host). This respects existing layering — core
  is a dependency floor, not dependency-free — and avoids a new package.
- **No host content in the platform.** Everything with a product's smell (Maple persona,
  cents-to-dollars, capability narratives) is host-authored and enters through host slots.
  Audited this session: `packages/` contains no Maple-flavored prompt content or behavior
  (comments using demo-bank as an example are fine; the repo ships it as an example app).
- **Host extension on both assemblers** with a guarded order (below): hosts append arbitrary
  prompt content to chat and voice alike; platform rules stay authoritative.
- Scope: all four audited quality gaps + the three UX sections (register, capabilities,
  proactivity).

## 1. Shared prompt core (`@flowlet/core` prompt module)

**Section builders**, each owning one rule set, emitting per-modality variants where the
registers genuinely differ:

- `genuiFormatSection()` — the `flowlet-genui/v1` payload protocol.
- `showVsSaySection(modality)` — one underlying rule, two registers (section 2).
- `refreshableViewsSection(modality)` — the `queries` protocol; voice variant covers the
  `source` declaration (section 3).
- `connectSection(modality)` — `request_connect` protocol for chat; the
  tools-present-means-connected / Connect-card rule for voice.
- `consentSection(modality)` — approval semantics; voice adds yes-means-most-recent.
  **All** voice consent copy centralizes here as named string builders: the driver's protocol
  paragraph, the `resolve_pending_approval` tool description, the pending-action note
  templates (act/critical), and the screen-only rejection copy. The shell driver imports
  these; it keeps its enforcement logic, not its own phrasings.
- `styleSection(norms)` — driven by host norms (e.g. no-emoji), not hardcoded.
- `registerSection(modality)` — how the agent talks (section 6).
- `capabilitiesSection(modality, toolSummary)` — grounded capability talk (section 7).
- `proactivitySection(modality)` — bounded suggestions (section 8).
- `guardrailSection(modality)` — a short closing restatement of the non-negotiables
  (consent/approval rules, no capability invention) emitted *after* host content.

**Assembly order (drift- and override-proof):** platform sections → typed host slots
(`identity`/`persona`, `capabilities` narrative, style `norms`) → free-form host `extras`
→ `guardrailSection`. Host content therefore never has recency over the guardrails, and the
contract is explicit: platform rules win on conflict.

**Assemblers:**

- `buildChatInstructions({ identity, brandGuidance, catalogs, capabilities, toolSummary, extras })`
- `buildVoiceInstructions({ persona, toolSummary, extras })`

**Dynamic assembly (review finding):** the chat toolset isn't known at config time — the
engine resolves Composio descriptors inside `run()`. `createFlowletAgent` therefore accepts
`instructions: string | ((ctx: { toolSummary }) => string)`, evaluated per run after tool
ingestion. Voice assembles client-side after the full `VoiceToolDef` list is composed (it
already is, in `voice-realtime.ts`), so `toolSummary` is derived right there.

**Consumers migrated:** demo-bank chat (`buildInstructions()` recomposes onto
`buildChatInstructions`), demo-bank voice (`INSTRUCTIONS` onto `buildVoiceInstructions`,
Maple persona and cents-to-dollars as host slots/extras), **and `@flowlet/next`'s default
prompt** — its duplicated `buildInstructions()` reroutes through the same builders so the
platform never ships two prompt sources. Chat behavior change should be nil (verified by the
frozen-fixture diff below); voice gains the new rule blocks.

## 2. Show-vs-say tuning

Underlying rule (shared): visuals carry data, words carry the takeaway. A view earns its place
only when it shows something a sentence can't; surrounding text names the headline — total,
outlier, next step — never the contents.

**Chat register:** today's ~10-line block moves in essentially unchanged.

**Voice register** grows from one sentence to a block covering observed failure modes:

- Show when data has shape (rows, comparisons, breakdowns) → display tool, speak only the
  headline. Never read more than ~3 items aloud.
- Say when the answer is one fact — no view for things a sentence carries.
- The screen is shared state — refer to visible views instead of re-fetching or re-describing.
- **Connect and approval cards are for actions** the user must take on screen; if a
  capability is already in the tool list, use it silently. (Data summaries via
  `show_table`/`show_key_value` are encouraged when data has shape — the rule targets
  action cards, per review.)
- No tool narration — user terms ("pulling up March"), never mechanics.
- Approvals are concrete — ask aloud with specifics (amount, payee, destination), one
  sentence.

## 3. Refreshable voice views

Today the voice display tools produce snapshots. Two review blockers reshaped the design:
reopen only re-runs `queries` and patches `payload.data` (it never rebuilds props), and the
current saved-view replay seam (`runQuery` → `/api/flowlet/action`) cannot execute
browser-run host tools at all.

**The declaration.** `show_table` / `show_key_value` gain an optional
`source: { tool, input, rowsPath }` — tool name, its input, and a JSON pointer to where the
row array lives inside that tool's result (host results are wrapped `{ status, ok, data }`,
so e.g. `/data/transactions`).

**The client builds a data-bound payload.** The voice layer keeps a short-lived per-session
cache of tool results (it executes the tools, so it has them). When a display call's `source`
matches a cached call AND validates — the value at `rowsPath` is an array of records whose
fields cover the declared column `key`s — `toView` emits a payload where:

- the canonical (capped, see section 5) result is stored verbatim at one path in `data`;
- the component's rows prop is *bound* with `{ $path }` into that subtree (so a data refresh
  actually changes what renders);
- `queries: [{ path, tool, input }]` is declared — exactly the chat protocol.

If `source` is absent, unmatched, or fails validation: today's snapshot, never an error.

**The replay registry.** Reopen gains a unified read-only replay path: read-tier host tools
replay client-side via `executeHostToolCall`; read-tier integration tools replay through the
existing voice bridge (with identical `capToolOutput`, so initial and refreshed shapes match);
server tools replay as today. Voice only emits `source` for tools present in this registry;
`refreshableViewsSection('voice')` tells the model to use raw field names as column `key`s
and to declare `rowsPath` honestly.

## 4. Richer voice carry-over: the session brief

Replace the raw 2KB text tail with a structured brief assembled client-side by
`voiceSessionBrief()` in `@flowlet/shell`. Sources are explicit (review: there is no complete
client-side tool ledger, and `render_view`/`request_connect` tool parts are deliberately
suppressed in the thread):

1. **Conversation tail** — from text parts, as today.
2. **On screen now** — from `data-ui` parts: title, component kind, row count, and
   provenance read from the payload's own `queries` when present.
3. **Recent tool results** — opportunistic digests from ordinary tool parts in
   `FlowletUIMessage[]` (tool, input, result shape/counts — never payloads).
4. **Saved flowlets** — names *and stable ids* from the `flows` prop.

Each block has its own character cap plus a total budget. Delivery is unchanged: the brief
renders to text into the existing `VoiceSessionInit.context` slot. A companion sentence from
the prompt core tells the model how to use the brief.

**Opening saved views by voice** (review: names alone open nothing): the shell contributes an
`open_saved_flowlet` voice tool (read tier) wired to the same callback the gallery uses
(`onOpenFlow`), taking the stable id from the brief. "Open my coffee view" resolves name →
id → callback.

## 5. Tool-output truncation

`capToolOutput(result, budget)` lives in `@flowlet/core` (isomorphic — review: two of the
four ingestion points are in the browser) and is applied at **all four** ingestion points:

- the chat engine's Composio wrapping (`@flowlet/runtime`),
- the voice integration bridge (server) — also on replay, so refreshed data matches,
- the React provider's client-executed host-tool runner (`@flowlet/react`),
- the voice driver, before tool results are serialized into the realtime session.

Behavior:

- Structure-aware, noise-first: HTML bodies become extracted text, base64 blobs are dropped,
  long arrays keep the first N items.
- **Shape-stable (review):** truncation never fabricates data. Markers appear only inside
  truncated strings ("…[truncated]") and as a single reserved top-level note on the result
  envelope summarizing what was cut and how to get more; array elements are dropped, never
  replaced with marker rows. Bound views and calculations keep working on capped data.
- Per-result budgets tuned per modality; voice caps tighter than chat. Refresh uses the same
  budget as initial fetch so shapes stay consistent.
- Deterministic only. No LLM summarization pass; possible follow-up if a toolkit proves too
  lossy.

## 6. Register: how the agent talks

Observed problem: voice yaps. Platform default register — "concise, warm, helpful" is a
platform guarantee, not host content; hosts flavor it through persona/extras but never have
to invent it.

Shared (both modalities):

- Answer first; explanation only if asked or genuinely needed.
- Warm but plain — no filler openers ("Sure!", "Great question!"), no enthusiasm inflation,
  no reflexive apologies.
- Never recap what you just did unless asked.

Voice anti-yap rules:

- One thought per turn; at most two sentences, then stop — no trailing "anything else?"
  every turn.
- Never announce what you are about to do; while a tool runs, silence or three words.
- Never restate the user's question back.
- When a view is on screen, one headline sentence — the screen carries the rest.
- Greeting one sentence; sign-off one sentence.

Chat register: match the user's message length; short paragraphs over bullet walls; rendered
UI carries data.

## 7. Capability discoverability

The toolset is dynamic (it changes when the user connects an integration), and nothing today
tells the model how to talk about what it can do.

- A compact capability summary is generated from the tool descriptors *at the point where
  the toolset is actually known* (chat: per-run via `instructions(ctx)`; voice: client-side
  when the `VoiceToolDef` list is composed): host-API reads and gated actions in user terms,
  connected integrations by toolkit, and the connectable-but-unconnected toolkit list.
- Rules in `capabilitiesSection(modality)`: answer capability questions with a handful of
  capabilities in user terms, never a tool inventory; never claim an unconnected toolkit —
  offer to connect it instead; voice answers in at most two sentences with an offer to put
  the full list on screen.
- Demo-bank's hand-written capabilities narrative remains a host slot; the generated summary
  is the grounding underneath.

## 8. Proactivity

- At most one volunteered suggestion per turn, and only when directly connected to what just
  happened: a view worth pinning, a repeatedly-fielded request that could become an
  automation, a missing integration that blocks a better answer.
- A declined or ignored suggestion is dropped for the session — never repeated.
- Suggestions never accompany an approval request; consent moments stay clean.
- In voice, a suggestion is a short sentence at the end of a turn, never its own turn.
- Suggestions only — acting on one still goes through normal consent.

## Testing & verification

- Prompt core: unit tests per section builder (both modality variants render, host slots and
  extras land in the guarded order, guardrail section is last, no host strings in platform
  output); snapshot tests on both assemblers.
- Chat migration: the **pre-migration** `buildInstructions()` output is frozen as a checked-in
  fixture (dynamic catalog/brand inputs normalized) *before* the recomposition lands; the
  post-migration assembled prompt is diffed against the fixture with intended hunks
  enumerated — the test cannot compare the new path to itself (review). Same treatment for
  `@flowlet/next`'s default prompt.
- Refreshable voice views: unit tests for cache + `source` validation (rowsPath resolution,
  column coverage, degradation on mismatch); replay-registry tests (host read tool via
  `executeHostToolCall`, integration tool via bridge with identical capping); live browser
  verification: build a table by voice, pin it, mutate data, reopen, observe refresh.
- Session brief: unit tests for block assembly, caps, and provenance-from-`queries`;
  `open_saved_flowlet` resolves name→id→callback; live verification of "which of those is
  the biggest?" mid-thread.
- Truncation: unit tests on Gmail-shaped fixtures (HTML body, base64, long arrays) plus
  shape-stability properties (no fabricated rows, envelope note only at root, capped array
  still valid input for a bound Table); applied-at-all-four-points integration tests.
- Register: live voice transcript checked against anti-yap rules (turn length, no
  announcements, no trailing offers).
- Capabilities: "what can you do?" asked with and without Gmail connected — answer matches
  the live toolset both times and offers the connect in the unconnected case.
- Voice behavior changes verified in a real browser session per repo rule (screenshots in
  PR).

## Out of scope

- End-user (consumer) custom instructions — considered, explicitly deferred; only the host
  developer extension seam ships.
- LLM summarization of tool outputs (deterministic capping only).
- Memory / grounding (ENG-189 / ENG-190) — unbuilt, unaffected.
- Any change to voice consent *enforcement* (client-side enforcement stays exactly as is;
  only the phrasing source moves).

## Review provenance

Dual Codex review 2026-07-04 (architecture+correctness lens; prompt-engineering+UX lens):
14 unique findings, all accepted and folded into v2 — notably the replay registry and
data-bound voice payloads (both blockers), per-run instruction assembly, `@flowlet/next`
migration, guarded extras order, isomorphic four-point shape-stable truncation, centralized
consent strings, `open_saved_flowlet`, frozen-fixture prompt diffing, and the
Connect/approval-card wording fix.
