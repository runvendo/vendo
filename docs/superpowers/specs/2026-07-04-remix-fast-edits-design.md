# Remix fast edits: `edit_view` deltas over a server-held source baseline

Date: 2026-07-04
Status: Approved design (Yousef; shaped by a Codex adversarial review that rejected the v1 draft — see "Decided against"), pre-plan
Owner: Yousef

## Why

Every remix turn — the first generation AND a one-line follow-up tweak — makes the model emit an entire `render_view` payload: node tree plus full ESM component source (up to 64 KB per component) inside tool-call JSON. Two costs:

1. **Latency.** 30–45 s per remix turn, dominated by model output tokens retyping the ~90% of the source that did not change.
2. **Robustness.** Large JSON string literals with embedded source intermittently carry raw control characters; the ai SDK keeps the unparsable input as a string and the next loop step 400s at the provider, killing the turn (reproduced on PR #28; app-level repair middleware exists in apps/gmail only).

The server already holds the captured source (`remix-sources.json`, PR #35). The fix: the model emits only a **reference to the base plus a small delta**; the server materializes, compiles, and validates the full payload through the existing gates.

**Key decision (differs from the rejected v1):** the baseline the model patches is **text, not a runnable payload**. It does not need to run — it needs to exist so the model stops retyping it. The model's delta supplies the semantic glue a deterministic transform cannot (wiring props to `data.anchor`, inlining imports the env manifest marks absent) — the same work it already does today, minus the unchanged bulk.

## Constraints that do not move

- Egress-jailed sandbox, CSP untouched; host source files never modified; pins fail open to the original children.
- OSS zero-sync path (snapshot baseline, no captured source) keeps working: no baseline → `edit_view` is not registered → today's behavior, byte for byte.
- The provenance boundary stands: client-supplied source is never trusted as captured code (`remix-enrich.ts` stripping stays).
- All downstream consumers of a rendered view (stage, `FlowletRemix`, pins, saved flowlets, drift semantics) see the same full `UINode` contract as today.

## Design

### Baseline: normalized captured source, resolved at request time

No `flowlet sync` changes. When a scoped anchor has captured source (via the existing resolver — which already re-reads the mapped file in dev, so staleness is solved by construction), the engine derives the baseline per component:

- deterministic normalization: named→default export rewrite (the transform the prompt currently *asks the model* to perform; doing it server-side removes a whole class of hunk mismatches),
- line numbering in the prompt rendering (numbers are prompt furniture, not part of the source),
- `baseHash` = hash of the normalized text.

The prompt's source section shows the numbered baseline and states its hash. The old "convert the named export" instruction is dropped (already applied); the manifest-driven import guidance from PR #35 stands.

### `edit_view` — the delta tool

Registered alongside `render_view` only when the scoped anchor has a baseline (captured source) or the request carries a valid pin envelope. Input:

- `base`: `"anchor"` (first remix — patch the normalized captured source) or `"pin"` (subsequent edit — patch the current pin's sources from its sealed envelope).
- `ops`, a small list of:
  - **Line hunks** — `{ component, baseHash, hunks: [{ startLine, oldLines: string[], newLines: string[] }] }`. Line arrays keep every JSON string single-line (no embedded newlines — kills the control-char failure mode structurally) and give the server deterministic apply errors: `oldLines` must match the base exactly at `startLine`, `baseHash` must match the held base. Chosen over exact-substring find/replace (brittle: whitespace, repeats) and unified diff (models flub hunk headers).
  - **Structured ops** for the high-confidence 80%: `setProp { nodeId, prop, value }`, `setData { path, value }`, `replaceText { component, old, new }` (single-line literals only), `addNode { node, parentId }`, `removeNode { nodeId }`, `addComponent { name, source }` (existing 16-component/64 KB caps).

The base's payload skeleton: for `"pin"`, the pin's current payload (from the envelope); for `"anchor"`, a minimal generated payload — one component holding the patched baseline source, one root node referencing it, empty `data` (`FlowletRemix` patches live context into `data.anchor` at render, as today). Ops like `setProp`/`addNode` operate on that skeleton.

Materialization, server-side: apply ops to the base's authored sources + payload skeleton → **op validator** (hash/line mismatches, root removal, duplicate node ids, dangling component refs, post-edit size caps) → recompile only touched components (`compileComponentSource`) → the existing `validateGeneratedPayload` + `hostPropIssues` gates → write the full `UINode` to the stream exactly as `render_view` does (same `remixAnchorId` tagging, same minted ids).

Errors are correctable tool results, like `render_view` today: a hunk mismatch echoes the actual lines at that range so the model can retry with one cheap turn. The tool description instructs: after two failed applies, fall back to full `render_view`.

For `base:"anchor"`, first-remix glue (props→`data.anchor` bindings, inlining absent imports) is expressed as hunks like any other edit; the prompt says so with one worked example.

### Sealed source envelope (editing an existing pin)

Pins are client-persisted (web storage) and today hold only the compiled payload. To let the server patch a pin without trusting the client:

- Every `edit_view`/remix-tagged `render_view` result is accompanied by a **sealed envelope**: `{ anchorId, sources (authored per component), baseHash, issuedAt }`, HMAC-signed with a server secret (the handler already requires server-side config; key derivation from it, no new required setup). Emitted as a data part alongside the `data-ui` node.
- `RemixPin` gains `envelope?: string` (opaque to the client). Opening the scoped overlay on a remixed anchor sends the envelope with the scope; `handleChat` verifies the seal — valid → the engine gets the pin's sources as the `"pin"` base (rendered in the prompt as delimited untrusted data, size-capped, same framing as the snapshot); invalid/absent/stale → `"pin"` base unavailable, the model is told only `"anchor"` exists.
- A tampered or replayed envelope therefore degrades, never escalates: the client can already render anything in its own jailed sandbox by writing localStorage; the seal only prevents client-authored text from entering the prompt/materialization path as if the server produced it.

Saved flowlets stay self-contained (no envelope) — remix source editing is pin-scoped. Recorded as an explicit decision; revisit if saved-view editing becomes a real ask.

### Shell / UX

- The pending skeleton in `use-flowlet-thread.ts` (currently keyed to `render_view` only) also covers `edit_view`.
- On a pin edit, the currently pinned view stays visible until the new node arrives (no flash to the original children).
- Pin/unpin/reset/drift semantics unchanged; the envelope rides the existing pin record.

### JSON-repair upstreaming (independent workstream)

Move the PR #28 middleware (stream-time repair of tool-call input control chars + `transformParams` sanitization of historical tool parts) from apps/gmail into `@flowlet/runtime` as an engine-level wrap, replacing the engine's current after-the-fact `{}` fallback for broken historical inputs. Small op strings make truncation rare; repair catches the residue. Ships with this epic but is independently mergeable.

## Threat model

- **Envelope**: client-held, server-sealed, verified on return; forgery/tampering yields "no pin base", not injection. Pin sources entering the prompt use the same delimited untrusted-data wrapper and caps as the snapshot/captured source.
- **Ops**: applied only to server-held or seal-verified text; every materialized payload passes the same validation/compile gates as a model-authored `render_view`. `edit_view` grants the model no capability it lacks today — it only changes who types the unchanged bytes.
- No sync/build-time execution of host code is added (the v1 jsdom smoke-render is rejected).

## Failure handling

- Hunk/hash mismatch → correctable error with actual lines echoed; repeated failure → model falls back to `render_view`.
- Envelope invalid → pin base unavailable, anchor base still offered; no baseline at all → `edit_view` absent, today's path.
- Materialized payload failing validation/compile → correctable error, nothing streamed (same as `render_view`).
- Rendered result failing in the stage → existing fail-open boundary + fatal-error channel; reset/retry pill unchanged.

## Testing

- Op application unit tests: hunk apply (match, mismatch, multi-hunk ordering, hash drift), each structured op, op-validator rejections (root removal, dangling refs, size growth), no-op detection.
- Envelope: seal/verify round-trip, tamper/replay/stale rejection, absent-secret behavior.
- Engine: `edit_view` registered iff baseline or valid envelope; prompt shows numbered normalized source + hash; named-export normalization; fallback instruction present.
- Shell: skeleton for `edit_view`; pinned view persists through an edit turn; envelope stored/sent on scoped open.
- Runtime middleware: JSON-repair stream + params tests ported from apps/gmail.
- Real-browser verification in Cadence: same remix asks as PR #35's fidelity check, measuring turn latency first-remix and follow-up-edit vs today; screenshots + timings in the PR.

## Decided against / deferred

- **v1 sync-time runnable baseline (rejected, Codex review):** deterministic conversion to a runnable payload is impossible for many anchors (app-local imports are `absent` in the env manifest by design; props→context mapping is semantic); jsdom smoke-render is low-fidelity and executes host code at build time; build-time LLM rescue makes builds nondeterministic and key-dependent. The text-baseline design gets the same token savings with none of this machinery.
- **Exact-substring find/replace and unified diff** as the delta encoding — brittle for models here; line-array hunks chosen (single-line JSON strings, deterministic errors).
- **Raw client-supplied pin sources** — replaced by the sealed envelope to preserve the provenance boundary.
- **Precompute for provably-simple anchors** (Codex's fallback suggestion) — not now; the request-time baseline already makes first remix fast. Revisit only if prompt-size or normalization cost shows up in practice.
- **Cosmetic-only fast path (`style_view`)** — subsumed by structured ops inside `edit_view`.
- **Progressive/streaming edit application** — an edit turn still lands as one full node; true incremental stage updates belong to the renderer-inversion epic.

## Dependencies

- PR #35 remix fidelity (merged): `remix-sources.json`, env manifest, source enrichment, prompt source section.
- PR #34 FlowletRemix surfaces (merged): pins, scope store, drift semantics.
- apps/gmail JSON-repair middleware (PR #28) as the port source.
