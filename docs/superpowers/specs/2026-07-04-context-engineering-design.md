# Context Engineering: Shared Prompt Core + Voice Quality — Design

**Date:** 2026-07-04
**Status:** Approved by Yousef (section-by-section, this session)
**Scope:** Platform-level. Ships in `@flowlet/core`, `@flowlet/runtime`, `@flowlet/shell`; demo-bank is the first consumer.

## Problem

Chat and voice agents get wildly asymmetric context. Chat runs on a ~200-line engineered
prompt (`apps/demo-bank/src/flowlet/agent.ts` `buildInstructions()`): identity, render-vs-talk
heuristics, brand guidance generated from sandbox tokens, the full genui format guide including
the refreshable-views `queries` protocol, live component catalogs, novel-codegen rules, connect
protocol, automations. Voice runs on ~10 sentences (`voice-realtime.ts` `INSTRUCTIONS` + the
driver's `protocolInstructions()`), knows none of the genui protocol, and phrases its few
overlapping rules (show-vs-say, connect, consent) in words that drift independently from chat's.

Audited consequences:

1. Voice-built views (`show_table` / `show_key_value`) are frozen snapshots — no `queries`,
   so pinned voice views never refresh.
2. No shared prompt source — chat and voice restate the same rules and drift.
3. Voice carry-over is a 2KB text-only tail (last 16 text turns) — no view awareness, no tool
   results, no saved-flowlet awareness.
4. Voice show-vs-say guidance is one sentence; failure modes (Connect-card-vs-tools wobble)
   were patched case by case.
5. Raw Composio outputs (full Gmail HTML bodies, base64) enter sessions untruncated — cost and
   context-quality blowup, worst at realtime-token prices.

## Decisions locked

- **Goal:** large quality lift for both modalities, delivered through shared structure.
- **Architecture:** prompt-fragment catalog (approach A) — named, parameterized section
  builders with modality variants, over one-canonical-prompt-compressed (B) and
  shared-constants (C).
- **Home:** `@flowlet/core`. Voice assembles its prompt in the browser and chat on the server;
  core is the dependency-free package both already import. `buildBrandGuidance` stays in
  `@flowlet/runtime`.
- **No host content in the platform.** Everything with a product's smell (Maple persona,
  cents-to-dollars, capability narratives) is host-authored and enters through the host
  extension seam. A planned `dataConventionsSection` was cut for this reason.
- **Host extension seam on both assemblers** (explicit requirement): hosts append arbitrary
  prompt content to chat and voice alike; platform rules stay intact underneath.
- Scope includes all four audited quality gaps: refreshable voice views, richer carry-over,
  tool-output truncation, show-vs-say tuning.

## 1. Shared prompt core (`@flowlet/core`)

A pure prompt module — string builders only, zero runtime dependencies, importable from
browser and server.

**Section builders**, each owning one rule set, emitting per-modality variants where the
registers genuinely differ:

- `genuiFormatSection()` — the `flowlet-genui/v1` payload protocol (chat consumes it; the
  voice refreshable-views work references it).
- `showVsSaySection(modality)` — one underlying rule, two registers (section 2).
- `refreshableViewsSection(modality)` — the `queries` protocol; the voice variant covers the
  `source` hint (section 3).
- `connectSection(modality)` — `request_connect` protocol for chat; the
  tools-present-means-connected / Connect-card rule for voice.
- `consentSection(modality)` — approval semantics; the voice variant adds the
  yes-means-most-recent-request rule.
- `styleSection(norms)` — driven by host norms (e.g. no-emoji), not hardcoded.

**Assemblers:**

- `buildChatInstructions({ identity, brand, catalogs, capabilities, extras })`
- `buildVoiceInstructions({ persona, extras })`

Host-authored prose (identity, persona, capability narrative, automations, data conventions)
slots in as parameters; the platform owns the rules, the host owns the voice. `extras` is an
ordered list of host blocks appended after the platform sections on both assemblers.

The shell driver's `protocolInstructions()` stays where it is (enforcement-coupled) but sources
its consent phrasing from `consentSection('voice')` so it cannot drift.

**Demo-bank migration:** `buildInstructions()` recomposes onto `buildChatInstructions`;
`voice-realtime.ts` `INSTRUCTIONS` recomposes onto `buildVoiceInstructions` with Maple persona
and cents-to-dollars passed as host content. Chat behavior change should be nil (refactor with
a drift guarantee); voice gains the new rule blocks.

## 2. Show-vs-say tuning

Underlying rule (shared): visuals carry data, words carry the takeaway. A view earns its place
only when it shows something a sentence can't; surrounding text names the headline — total,
outlier, next step — never the contents.

**Chat register:** today's ~10-line block moves in essentially unchanged (trigger verbs,
"most turns are text", default-to-text).

**Voice register** grows from one sentence to a block covering observed failure modes:

- Show when data has shape (rows, comparisons, breakdowns) → display tool, speak only the
  headline. Never read more than ~3 items aloud.
- Say when the answer is one fact — no view for things a sentence carries.
- The screen is shared state — refer to visible views instead of re-fetching or re-describing
  (pairs with the session brief, section 4).
- Cards are actions, not decoration — a card appears only when the user must act on it
  (connect, approve); if the capability is already in the tool list, use it silently. This
  generalizes the Connect-card-vs-tools fix.
- No tool narration — user terms ("pulling up March"), never mechanics.
- Approvals are concrete — ask aloud with specifics (amount, payee, destination), one sentence.

## 3. Refreshable voice views

Today the voice display tools produce snapshots. Chat's refresh protocol stores tool output
verbatim in `data` and reshapes at render time; voice models pass already-reshaped rows, so a
naive re-run would break shape. The design exploits the voice topology: host tools execute in
the browser (`VoiceToolDef.execute`), so the client holds the raw results.

1. `show_table` / `show_key_value` gain an optional `source: { tool, input }` — a one-line
   honest declaration by the model that the shown data came from that call.
2. The client, not the model, builds the refreshable payload: it keeps a short-lived
   per-session cache of recent tool results; when a display call's `source` matches a cached
   call, `toView` stores the raw result verbatim in the payload's `data` and emits
   `queries: [{ path, tool, input }]` — exactly the chat protocol.
3. `refreshableViewsSection('voice')` instructs the model to use raw field names as column
   `key`s (human `label`s free-form) so re-run rows still bind.
4. Graceful degradation: a `source` that matches nothing cached yields today's snapshot,
   never an error.

Outcome: a voice-pinned "March transactions" view re-runs `listTransactions` on reopen, same
as chat-built views.

## 4. Richer voice carry-over: the session brief

Replace the raw 2KB text tail with a structured brief assembled client-side by a
`voiceSessionBrief()` builder in `@flowlet/shell` (chat's host tools also execute in the
browser, so the thread already holds everything needed). Four blocks, each with its own
character cap plus a total budget:

1. **Conversation tail** — the existing text tail, kept.
2. **On screen now** — one line per visible view: title, component kind, row count, and the
   source tool + input when known. Makes "the biggest one there" resolvable and suppresses
   re-rendering of already-visible views.
3. **Recent tool results** — compact digests (tool, input, result shape/counts — not
   payloads) so voice reuses knowledge instead of re-fetching.
4. **Saved flowlets** — names only, so "open my coffee view" works.

Delivery is unchanged: the brief renders to text into the existing `VoiceSessionInit.context`
slot — no driver protocol change. A companion sentence from the prompt core tells the model how
to use the brief.

## 5. Tool-output truncation

Deterministic capping at the two server-side ingestion points: the chat engine's Composio
wrapping in `@flowlet/runtime`, and the voice tool bridge (`/api/flowlet/voice/tools`) before
results reach the browser. One shared helper in `@flowlet/runtime`:
`capToolOutput(result, budget)`.

- Structure-aware, noise-first: HTML bodies become extracted text, base64 blobs are dropped,
  long arrays keep the first N items plus a count marker — known offenders shrink before real
  data is touched.
- Per-result budgets tuned per modality; voice caps tighter than chat (realtime tokens are the
  expensive ones).
- Honest markers: every cut is replaced with an explicit note (e.g. "[body truncated from
  214KB; ask for a specific field if you need more]") so the model knows it sees a digest and
  drills in rather than hallucinating.
- Deterministic only. No LLM summarization pass (latency, cost, new mid-tool-call failure
  mode); if capping proves too lossy for a toolkit, an LLM pass is a possible follow-up.

## Testing & verification

- Prompt core: unit tests per section builder (both modality variants render, host extras
  append in order, no host strings in platform output); snapshot tests on both assemblers.
- Demo-bank chat migration: assembled prompt diffed against the current `buildInstructions()`
  output — intended differences enumerated, everything else identical.
- Refreshable voice views: unit tests for the client cache + `source` matching + degradation;
  live browser verification: build a table by voice, pin it, mutate data, reopen, observe
  refresh.
- Session brief: unit tests for block assembly and caps; live verification of the
  "which of those is the biggest?" scenario mid-thread.
- Truncation: unit tests on representative Gmail-shaped fixtures (HTML body, base64, long
  arrays); live verification that a receipt lookup by voice stays under budget and still
  answers correctly.
- Voice behavior changes verified in a real browser session per repo rule (screenshots in PR).

## Out of scope

- End-user (consumer) custom instructions — considered, explicitly deferred; only the host
  developer extension seam ships.
- LLM summarization of tool outputs (deterministic capping only).
- Memory / grounding (ENG-189 / ENG-190) — unbuilt, unaffected.
- Any change to voice consent enforcement (client-side enforcement stays exactly as is;
  only the phrasing source moves).
