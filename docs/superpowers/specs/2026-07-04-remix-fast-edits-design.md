# Remix fast edits: `edit_view` deltas over a server-held source baseline

Date: 2026-07-04
Status: Approved design (Yousef; v1 draft rejected by a Codex adversarial review, v2 revised after two further Codex reviews — findings triaged below), pre-plan
Owner: Yousef

## Why

Every remix turn — the first generation AND a one-line follow-up tweak — makes the model emit an entire `render_view` payload: node tree plus full ESM component source (up to 64 KB per component) inside tool-call JSON. Two costs:

1. **Latency.** 30–45 s per remix turn, dominated by model output tokens retyping the ~90% of the source that did not change.
2. **Robustness.** Large JSON string literals with embedded source intermittently carry raw control characters; the ai SDK keeps the unparsable input as a string and the next loop step 400s at the provider, killing the turn (reproduced on PR #28; app-level repair middleware exists in apps/gmail only).

The server already holds the captured source (`remix-sources.json`, PR #35). The fix: the model emits only a **reference to the base plus a small delta**; the server materializes, compiles, and validates the full payload through the existing gates.

**Key decision (differs from the rejected v1):** the baseline the model patches is **text, not a runnable payload**. It does not need to run — it needs to exist so the model stops retyping it. The model's delta supplies the semantic glue a deterministic transform cannot (wiring props to `data.anchor` bindings, inlining imports the env manifest marks absent) — the same work it already does today, minus the unchanged bulk.

## Constraints that do not move

- Egress-jailed sandbox, CSP untouched; host source files never modified; pins fail open to the original children.
- OSS zero-sync path (snapshot baseline, no captured source) keeps working: no baseline → `edit_view` is not registered → today's behavior, byte for byte.
- The provenance boundary stands: client-supplied source is never trusted as captured code (`remix-enrich.ts` stripping stays); anything client-held that re-enters the server does so only under a verified server seal.
- All downstream consumers of a rendered view (stage, `FlowletRemix`, pins, saved flowlets, drift semantics) see the same full `UINode` contract as today.

## Design

### Baseline: normalized captured source, resolved at request time

No `flowlet sync` changes. The source resolver/enrichment contract changes from bare `string` to a **normalized source record** — `{ source, exportName?, sourceHash, truncated }` (`RemixSourceRecord` already carries the metadata; the resolver currently throws it away). When a scoped anchor has captured source, the engine derives the baseline per component:

- deterministic normalization: LF line endings; named→default export rewrite using the record's `exportName` (the transform the prompt currently asks the model to perform; doing it server-side removes a class of hunk mismatches),
- line numbering in the prompt rendering only (numbers are prompt furniture, never part of the source or of `oldLines`),
- `baseHash` = hash of the normalized text; `normalizerVersion` recorded so a normalizer change invalidates stale bases loudly.

`edit_view` is **not offered for truncated baselines** (the 48 KB enrichment cap): hunks against text the model cannot fully see are guesswork. Truncated → `render_view` only, as today.

Staleness: in dev, enrichment already re-reads the mapped file per request, so the baseline tracks the editor. In prod, the baseline is the captured copy — consistent with the deployed bundle by construction of `prebuild` sync; drift against a *newer* deploy is what `baseHash`/`sourceHash` and the existing component-drift semantics catch.

### `edit_view` — the delta tool

Registered alongside `render_view` only when the scoped anchor has a non-truncated baseline; `base:"pin"` additionally requires a verified envelope (below). Input:

- `base`: `"anchor"` (first remix — patch the normalized captured source) or `"pin"` (subsequent edit — patch the sealed authored state).
- `ops`: **source hunks only in the MVP** (structured node/data ops were reviewed out: the remix skeleton has exactly one node, so `setProp`/`addNode`/`setData` buy nothing; graph restructuring is `render_view`'s job):
  - `editSource { component, baseHash, hunks: [{ startLine, oldLines: string[], newLines: string[] }] }`
  - `addComponent` was dropped at build time: generated components load as isolated blob modules with no cross-imports, so a component without a node referencing it is unmountable — and `addNode` was already out. Sub-structure lives as inline function components in the same module (idiomatic React); multi-component views stay on `render_view`.

**Hunk contract (exact):** `startLine` is 1-based against the LF-normalized base as shown numbered in the prompt. All hunks in one call are coordinates against the **original** base (not sequentially remapped); the server sorts and applies atomically in descending `startLine` and rejects overlapping ranges. `oldLines` must match the base lines at `startLine` exactly; `oldLines: []` means insert before `startLine` (`startLine = lineCount + 1` appends). Every string in `oldLines`/`newLines`/`sourceLines` must be a single line — `\r` or `\n` anywhere in them is a schema-level rejection. Caps: ≤ 32 hunks per op, ≤ 16 ops per call, ≤ 2000 chars per line. On mismatch the error names the component, the expected range, and echoes the **actual** base lines at that range (inside the untrusted-data framing) so one cheap retry can fix it.

**The base's payload skeleton:** for `"pin"`, the sealed authored payload from the envelope; for `"anchor"`, a deterministic minimal payload — one component holding the patched baseline source, one root node with props `{ anchor: { $path: "/anchor" } }`, empty `data` (`FlowletRemix` patches live context into `data.anchor` at render, as today).

**Materialization, server-side:** apply hunks to authored sources → edit-scoped validation stricter than `validateGeneratedPayload` (root present and reachable, every `source:"generated"` ref has a definition, per-component and total size caps re-checked **after** join and again after compile) → recompile touched components (`compileComponentSource`) → the existing `validateGeneratedPayload` + `hostPropIssues` gates → write the full `UINode` exactly as `render_view` does (same `remixAnchorId` tagging, same minted ids). Errors are correctable tool results; the tool description instructs falling back to full `render_view` after two failed applies.

For `base:"anchor"`, first-remix glue (props→`data.anchor` bindings, inlining absent imports) is expressed as hunks like any other edit; the prompt says so with one worked example.

### Sealed authored-state envelope (editing an existing pin)

`render_view` validates the **authored** payload but streams the **compiled** one, so today's pins hold no authored source at all. The envelope carries the authored state across the client without trusting it:

- When a remix-tagged `edit_view`/`render_view` result is produced, the server mints an envelope from the authored state **before compilation**: `{ v, kid, anchorId, principalUserId, payload (authored skeleton), sources (authored per component), sourceHash, baseHash, payloadHash, normalizerVersion, issuedAt }`, HMAC-signed over canonical JSON, emitted as a typed **`data-remix-envelope`** part paired to the `data-ui` node by node id (`FlowletDataParts` gains the entry).
- **Key sourcing:** `FLOWLET_SEAL_SECRET` (env or handler option) when set; otherwise derived via HKDF from the provider API key (zero-config path; key rotation gracefully invalidates envelopes). Neither available → envelopes are not minted and `base:"pin"` is not offered; `base:"anchor"` is unaffected.
- **Verification on return:** HMAC valid, `v`/`kid` known, `anchorId` matches the scoped anchor, `principalUserId` matches the resolved principal, `payloadHash`/`sourceHash` internally consistent, `normalizerVersion` current. Any failure → `base:"pin"` silently unavailable this turn (the model is told only `"anchor"` exists); never an escalation path. No expiry: pins live for months by design; replay of a user's own stale envelope only degrades fidelity, and staleness is caught by `baseHash`/drift.
- `RemixPin` gains `envelope?: string` (opaque); `applyRemix` stores the paired envelope with the pin; `AnchorScope` gains `envelope?` and the scoped-open path sends it; `handleChat` verifies before the engine sees it. Pin sources entering the prompt are size-capped and framed as untrusted data.
- A tampered envelope therefore degrades, never escalates: the client can already render anything in its own jailed sandbox by writing localStorage; the seal only prevents client-authored text from entering the prompt/materialization path as if the server produced it.

Saved flowlets stay self-contained (no envelope) — remix source editing is pin-scoped. Recorded as an explicit decision; revisit if saved-view editing becomes a real ask.

### Prompt and policy integration

- `edit_view` joins the default policy allowlist (`ENGINE_ALLOW` in `default-policy.ts`) — an approval prompt per edit would erase the latency win; the tool grants no capability `render_view` lacks.
- The agent prompt's "there is ONE rendering tool" section (`agent.ts`) and the anchor source section (`engine.ts`) become conditional: when `edit_view` is registered, the instruction is "remix by patching the numbered baseline via `edit_view`; use `render_view` only when no baseline exists, for non-remix views, or after two failed applies."
- **Untrusted-data framing hardening:** the static `<<<FLOWLET_CAPTURED_SOURCE` delimiters are replaced with per-request nonce delimiters (verified absent from the wrapped content) for captured source, pin sources, and echoed mismatch lines — a model-authored pinned source could otherwise contain the closing delimiter and inject prompt text.

### Shell / UX

- The pending skeleton in `use-flowlet-thread.ts` (currently keyed to `render_view` only) also covers `edit_view`.
- On a pin edit, the currently pinned view stays visible until the new node arrives (no flash to the original children).
- Pin/unpin/reset/drift semantics unchanged; the envelope rides the existing pin record.

### JSON-repair upstreaming (independent workstream)

Move the PR #28 middleware (stream-time repair of tool-call input control chars + `transformParams` sanitization of historical tool parts) from apps/gmail into `@flowlet/runtime` as an engine-level wrap, replacing the engine's current after-the-fact `{}` fallback for broken historical inputs. Line-array ops make truncation structurally rare; repair catches the residue (and protects `render_view`, which remains in play).

## Benchmarks (required deliverable)

A repeatable harness (script against a running demo host, warm tool caches unless stated) measuring, before/after, on the same anchors and asks:

- **Wall-clock:** send→`data-ui` part received, and send→stage-rendered, for (a) first remix, (b) follow-up pin edit, (c) a forced failed-hunk retry (the real p95 risk).
- **Tokens/bytes:** provider input and output tokens per turn, tool-input bytes, stream bytes.
- **Steps/reliability:** model steps per turn, hunk apply failure rate over N ≥ 10 varied asks, JSON-parse failure rate.
- **Server costs (sanity):** hunk-apply + validation + compile time (expected negligible).
- Small / medium / near-cap (48 KB) sources; cold-cache first-turn noted separately (Composio/MCP ingestion can dominate cold first-token and must not be attributed to this change).

Numbers land in the PR next to the screenshots.

## Threat model

- **Envelope**: client-held, server-sealed, bound to anchor + principal + normalizer version, verified on return; forgery/tampering/cross-user replay yields "no pin base", not injection. Pin sources entering the prompt use nonce-delimited untrusted-data framing and caps.
- **Ops**: applied only to server-held or seal-verified text; every materialized payload passes the same validation/compile gates as a model-authored `render_view`. `edit_view` grants the model no capability it lacks today — it only changes who types the unchanged bytes.
- No sync/build-time execution of host code is added (the v1 jsdom smoke-render is rejected).

## Failure handling

- Hunk/hash mismatch → correctable error with actual lines echoed (nonce-framed); repeated failure → model falls back to `render_view`.
- Envelope invalid/absent or no seal key → pin base unavailable, anchor base still offered; no baseline at all (or truncated) → `edit_view` absent, today's path.
- Materialized payload failing validation/compile → correctable error, nothing streamed (same as `render_view`).
- Rendered result failing in the stage → existing fail-open boundary + fatal-error channel; reset/retry pill unchanged.

## Testing

- Hunk engine unit tests: match, mismatch (error echoes actual lines), insert/append/delete, descending-order atomic apply, overlap rejection, `\r`/`\n` rejection, caps, baseHash drift, normalizer versioning.
- Envelope: mint/verify round-trip, tamper/cross-anchor/cross-principal/stale-normalizer rejection, key sourcing (secret, HKDF fallback, neither → pin base off), pairing by node id.
- Engine: `edit_view` registered iff non-truncated baseline; prompt shows numbered normalized source + nonce delimiters; conditional rendering-tool instructions; resolver record contract; skeleton `{ anchor: { $path: "/anchor" } }`.
- Policy: `edit_view` allowed by default policy.
- Shell: skeleton for `edit_view`; pinned view persists through an edit turn; envelope stored on pin and sent on scoped open.
- Runtime middleware: JSON-repair stream + params tests ported from apps/gmail.
- Adversarial: pinned source containing the closing delimiter / instruction text does not escape the untrusted framing (extends the PR #35 adversarial test).
- Real-browser verification in Cadence + the benchmark harness above; screenshots + numbers in the PR.

## Build-time additions (post-benchmark, Yousef-approved)

Benchmarking the shipped design surfaced where the remaining first-remix time
went, and three additions collapsed it (all deterministic — sync still never
calls an LLM):

1. **Coordinate-mode hunks** — `{ startLine, endLine, newLines }` without
   `oldLines`: the op's `baseHash` already pins the exact base text, so quoting
   is optional self-checking. Kills the mismatch-retry class; prompt prefers it.
2. **App-local closure vendoring** (the v1-deferred item, now evidence-backed):
   `flowlet sync` bundles each app-local import's transitive closure as a
   vendored ESM entry (aliases resolved; refusal rules on every app file in the
   closure; npm-inside-closure bundled in; react/vendored/shims externalized;
   css inert). Plus `flowlet.config.json` `remixAnchors` capture overrides for
   anchors whose child heuristic picks the wrong file.
3. **Prepared baselines** — the mechanical first-remix glue done ONCE at sync:
   an AST transform strips the `@flowlet/shell` import and unwraps the
   component's own `<FlowletRemix>` element (surgical splices, byte-preserving,
   fail-closed on non-mechanical usage). Records carry `prepared` alongside the
   verbatim `source`; dev re-read keeps it only while the file matches the
   captured hash; the engine shows it as the baseline and announces
   SANDBOX-READY only when every import actually resolves in the anchor's env.
4. **swr shim data feed** (PR #35 gap found in browser verification): the stage
   now injects `data.anchor` as `window.__flowletAnchorData` at init and on
   data updates — the shim shipped reading it but nothing ever set it. Hosts
   key wrapper `context` by the component's own fetch key and the prepared
   baseline renders live data unmodified.

Measured on Cadence (N=10 live turns each): first remix p50 32.2s (main) →
4.4s (prepared, 10/10, one retry across the run); pin edits ~6s throughout.

## Decided against / deferred

- **v1 sync-time runnable baseline (rejected, Codex review 1):** deterministic conversion to a runnable payload is impossible for many anchors (app-local imports are `absent` in the env manifest by design; props→context mapping is semantic); jsdom smoke-render is low-fidelity and executes host code at build time; build-time LLM rescue makes builds nondeterministic and key-dependent. The text-baseline design gets the same token savings with none of this machinery.
- **Exact-substring find/replace and unified diff** as the delta encoding — brittle for models here; line-array hunks chosen (single-line JSON strings, deterministic errors).
- **Structured node/data ops (`setProp`, `setData`, `addNode`, `removeNode`, `replaceText`) — reviewed out of the MVP** (Codex review 3): the remix skeleton has one node, so they add schema surface and validator obligations (including proto-pollution guards) for almost no expressiveness; `render_view` covers restructuring. Revisit with usage evidence.
- **Raw client-supplied pin sources** — replaced by the sealed envelope to preserve the provenance boundary.
- **Envelope expiry** — omitted deliberately; pins are long-lived and replay of one's own envelope is not an escalation. Revisit when sharing/promotion ships (that epic's mandate already requires approval + kill switch).
- **Precompute for provably-simple anchors** (Codex fallback suggestion) — not now; the request-time baseline already makes first remix fast.
- **Cosmetic-only fast path (`style_view`)** — subsumed by hunks.
- **Progressive/streaming edit application** — an edit turn still lands as one full node; true incremental stage updates belong to the renderer-inversion epic.

## Dependencies

- PR #35 remix fidelity (merged): `remix-sources.json`, env manifest, source enrichment, prompt source section.
- PR #34 FlowletRemix surfaces (merged): pins, scope store, drift semantics.
- apps/gmail JSON-repair middleware (PR #28) as the port source.
