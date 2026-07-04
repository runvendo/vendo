# Source-baseline remixing: the agent edits the dev's real component

Date: 2026-07-04
Status: Approved design (option A of the remix-fidelity discussion; promote-to-code is option B, deferred), pre-plan
Owner: Yousef (approval delegated for spec + plan; build not started)

## Why

FlowletRemix (PR #34) remixes from a sanitized DOM snapshot. That reproduces how a component looks, but the agent has to reverse-engineer structure and logic from rendered output. When the dev's actual component source is available, the agent can produce an edited variant of the real thing: same conditional logic, same data handling, same markup intent, with only the requested delta changed.

Constraints that do not move:

- The host component's source file is never modified. Output still runs in the egress-jailed sandbox, still pins per user, still resets.
- Source never ships to the browser. It lives server-side and is injected into the model context on the server, exactly like nothing else the client can read.
- Zero new config for the happy path: `flowlet init` captures sources; installs without the extractor fall back to today's snapshot baseline automatically.

## How it works

```
flowlet init (build time)                      chat request (runtime)
  scan app for <FlowletRemix id="...">           client sends anchors metadata (id, label,
  resolve the wrapped child component              context, DOM snapshot) — unchanged
  capture its source file                        server: handler looks up source by anchorId
  write .flowlet/remix-sources.json                and adds it to the scoped anchor block
                                                 engine: system prompt = baseline snapshot
                                                   + REAL SOURCE + mapping instructions
```

## Contracts (additive)

- `AnchorRef` scoped block gains `source?: string` (core protocol). The CLIENT never sets it — the shell never sees source. It is server-populated only; the chat handler strips any client-supplied value before enrichment (defense against a tampered client injecting fake "source" into its own prompt is not the threat — prompt-budget abuse is — but stripping keeps the field's provenance unambiguous).
- Cap: 48 KB per source payload; oversized sources are truncated with a visible marker (same convention as the DOM snapshot).

## Extractor (flowlet-cli)

A new deterministic step in `flowlet init` (and re-runnable on its own):

- AST-scan the app source for `<FlowletRemix id="...">` usages. Only literal string `id`s are capturable; dynamic ids are skipped with a report warning.
- Resolve the wrapped child: the single top-level JSX child's component identifier, followed through its import to a source file in the app. Multi-child or non-component children capture the enclosing file instead.
- Write `.flowlet/remix-sources.json`: `{ [anchorId]: { file: string, exportName?: string, source: string } }`. Source is the component's file content, verbatim.
- Fail-open per anchor: anything unresolvable is omitted (that anchor keeps the snapshot baseline) and listed in the extraction report. No LLM in this path — it is pure AST work, same fidelity rules as the ENG-197 route scan.
- One level only in v1: the component's own file. Local helper imports are NOT inlined (declared limitation; the file's imports still appear as import statements the model can see and reason about).

## Server injection (@flowlet/next)

- `loadFlowletDir` also reads `remix-sources.json` (absent → empty map).
- `handleChat` enriches the LAST user message's `anchors.scoped` with `source` when the map has its anchorId, after stripping any client-supplied `source`. Enrichment is handler-side so the engine stays transport-agnostic.
- Handler option `remixSources?: Record<string, string> | (anchorId: string) => string | undefined` overrides/augments the file for hosts that do not use the extractor (Cadence's hand-rolled chat handler passes its own map the same way).

## Engine prompt (flowlet-runtime)

When the scoped anchor carries `source`, the anchor section adds it after the DOM snapshot:

- "This is the component's REAL source code. Produce your view as an EDITED VARIANT of this component: keep its structure, conditional logic, and data handling; change only what the user asked."
- Mapping rules, stated explicitly (the sandbox has none of the app's modules):
  - App imports do not exist in the sandbox. Reimplement what the component uses: framework links/navigation become `props.flowlet.dispatch` actions or plain non-navigating elements; data-fetching hooks are replaced by reading the anchor data at `data.anchor` via `{ $path }` bindings; local UI helpers (badges, cards, progress bars) are reimplemented inline or replaced with catalog components.
  - CSS utility classes from the app (e.g. Tailwind) are inert in the sandbox — same rule as the snapshot: use them to infer the intended look, restyle with inline styles + `--flowlet-*` variables.
- The DOM snapshot stays in the prompt as ground truth for what the component looks like WITH REAL DATA (the source shows logic; the snapshot shows outcome). Fidelity gain from source: structure and logic. Styling still requires translation — that is honest and documented.

## What does not change

- Shell, pins, Apply/Reset, toasts, registry, scope store: untouched. This is a prompt-fidelity upgrade behind the same seams.
- Snapshot-only remixing remains the fallback whenever no source is captured — same UX, lower fidelity.

## Failure handling

- Missing/unreadable `remix-sources.json`: empty map, snapshot baseline, no error.
- Source lookup miss for a scoped anchor: snapshot baseline, no error.
- Oversized source: truncated with marker; the model is told truncation happened.

## Testing

- CLI: AST scan fixtures (literal id capture, dynamic id skipped + reported, multi-child fallback, import resolution, missing file fail-open). Ground truth: demo-bank after wrapping a widget.
- @flowlet/next: flowlet-dir parses the new file; handleChat strips client-supplied source and enriches from the map; option override wins.
- Engine: source present → prompt contains the source and the edited-variant instruction; absent → today's prompt byte-identical.
- Real-browser fidelity check (verification, not CI): remix the same wrapped widget with and without source and compare — the PR carries both screenshots.

## Decided against / deferred

- Promote-to-code (option B: a remix graduates into a reviewed source diff/PR for the dev) — deferred to the publish epic (ENG-198).
- Inlining the component's local dependency closure — deferred until a real host shows the single-file source is not enough.
- Client-side source shipping of any kind — rejected outright.
- Letting hosts mark sources as secret per-anchor — YAGNI until someone asks.

## Dependencies

- PR #34 (FlowletRemix + FlowletToasts) — this stacks directly on it.
- ENG-197 extractor conventions (deterministic AST, fail-open with report).
