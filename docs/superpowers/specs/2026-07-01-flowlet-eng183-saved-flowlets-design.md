# Flowlet ENG-183 — Persistent & saved flowlets

**Date:** 2026-07-01
**Status:** Draft — implementation-level design inside locked platform architecture (Decision 6). Library UX is gated on Yousef's review.
**Scope:** Persistence layer for saved flowlets (schema, query capture, real embedded store, reopen flow) plus demo-bank wiring. The library UI surface is designed separately behind the UI gate.
**Sources:** Platform architecture Decision 6 (`saved_flowlets`), Linear ENG-183, F5 shell design (FlowletStore seam).

## What is locked (not re-decided here)

- A saved flowlet is: **declarative UI tree + bound data query + originating prompt + name/pin** (architecture Decision 6).
- Reopening **re-renders the tree and re-runs the query through the normal tool path** — fresh data, same policy.
- Default reopen behavior per the Linear issue: **live re-run with graceful fallback to snapshot**.
- All persistence sits behind the **FlowletStore seam**; embedded impl is the host's/browser's, cloud impl (Postgres) is ENG-198's.
- Sharing is out of scope (deferred).

## The gap this fills

Today a generated view is a `GeneratedNode` whose `GeneratedPayload.data` is baked in at generation time. Nothing records *where the data came from*, so nothing can refresh it. The store seam exists but the shell only ever gets the loud in-memory fallback, and demo-bank keeps "saved tabs" in React state that dies on reload.

## Design

### 1. Bound data query: declared provenance in `render_view`

`GeneratedPayload` gains an optional field:

```ts
interface DataQuery {
  path: string;   // RFC 6901 JSON Pointer into `data` ("" = whole model)
  tool: string;   // registered tool name (e.g. "get_transactions")
  input?: Record<string, unknown>; // the tool input to replay
}
// GeneratedPayload.queries?: DataQuery[]
```

When the agent builds a data-bound view, it declares which tool call produced each `data` subtree: it places the tool's result **verbatim** at `path` in `data` and lists `{path, tool, input}` in `queries`. Any reshaping (bucketing, aggregation) happens in generated component code, not between tool and data model — that is what makes the query deterministically re-runnable without an LLM.

- `validateGeneratedPayload` validates `queries` (pointer syntax, non-empty tool, plain-object input, cap `MAX_GENUI_QUERIES = 16`). Optional and additive: `flowlet-genui/v1` stays; older payloads remain valid.
- `render_view`'s zod schema + description teach the model the contract. The demo agent's system prompt gets a short "make views refreshable" section.
- Views without `queries` are simply snapshots — still saveable, never refreshed. Graceful by construction.

**Alternatives rejected:**
- *Auto-capture the turn's tool calls and replay them:* the agent freely reshapes tool output into `data`, so replayed results can't be rebound deterministically; binding via an LLM on every reopen contradicts "re-renders the tree" and costs a model call per open.
- *Snapshot-only:* violates locked Decision 6 and the Linear default.

### 2. Schema: the `Flowlet` record (store seam)

```ts
interface Flowlet {
  id: string;
  name: string;
  node: UINode;      // the tree; a GeneratedNode's payload carries data + queries
  prompt?: string;   // originating user prompt
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}
```

Additive on the existing `Flowlet` (`id, name, node, updatedAt`); existing consumers (FlowGallery) keep working. The seam's four ops (`list/load/save/remove`) stay — rename and pin are `save()` of a loaded record; no new seam methods until the library UI proves a need (YAGNI).

Ownership/tenancy: embedded mode is single-tenant by definition; the store factory takes an optional `namespace` (e.g. user id) so records are user-scoped where the host has users. Retention/deletion beyond `remove()` and cloud tenant isolation belong to ENG-198/ENG-194.

### 3. Real embedded store: `createWebStorage`

A `FlowletStore` over `localStorage` (chosen over IndexedDB: matches the existing FlowletSlot precedent, ~40 lines, sync and test-friendly; payloads are capped well under quota):

- One key per record: `flowlet:saved:<namespace>:<id>`; `list()` scans the prefix.
- Injectable `Storage` (defaults to `globalThis.localStorage`) so tests need no browser and SSR guards are explicit.
- Failures are loud: quota overflow or unavailable storage **throws** from `save()` — no silent fallback (per silent-failure standing rules). Malformed stored JSON is skipped from `list()` with a `console.warn` naming the key.
- Timestamps from `Date.now()` (the deterministic clock stays only in the in-memory test store).

The loud in-memory fallback in `FlowletShellProvider` remains for store-less hosts — its warning already points here. demo-bank stops hitting it by passing this store.

### 4. Reopen flow: snapshot first, then live re-run

A pure helper + tiny hook in `flowlet-shell` (no new UI):

```ts
type RunQuery = (q: DataQuery) => Promise<unknown>;   // host seam
reopenFlowlet(flowlet, runQuery?) → { node, refresh(): Promise<RefreshResult> }
```

1. Render the saved node immediately (snapshot — instant open, works offline).
2. If the node is generated, has `queries`, and the host provided `runQuery`: run all queries; patch each result into `data` via `applyPointerPatch`; emit a new node with the same structure. The stage adapter's existing data-delta path updates props in place — no re-init flicker.
3. Per-query failure (policy deny, unknown tool, network): keep the snapshot for that path and report `{status: "snapshot", errors}` so the surface can say "showing saved data". Nothing throws away the view.
4. On a fully-fresh run, write the refreshed `data` back through `store.save()` so the next snapshot is newer; a write-back failure logs and does not affect the open view. The pure helper takes no store; the hook form (`useReopenFlowlet`) reads the store from `ShellContext` and owns the write-back.

`RunQuery` is a new host-provided shell seam next to `renderNode`. It is deliberately the same shape as a stage `ActionRequest` — in demo-bank it is one `fetch` to the existing policy-governed `/api/flowlet/action` route (`{action: q.tool, payload: q.input}`). Same tools, same policy, zero new server surface. Cloud mode later implements it against the session tool path (ENG-198).

### 5. demo-bank wiring

- `FlowletRoot` passes `store: createWebStorage({ namespace: "maple-demo" })` and `runQuery` (action-route fetch).
- The `/flowlet` page's auto-saved tabs persist through the store instead of React state, and the auto-save filter is fixed to include `generated` nodes (post-ENG-200 every view is generated; today's `kind === "component"` filter saves nothing). Prompt capture: the nearest preceding user text item in the thread becomes `prompt`. No visual changes — same tab strip, now survives reload and re-runs queries on open.
- FlowletSlot's raw-localStorage pinning is left as is (different concern: per-slot placement); noted for a later alignment pass.

### 6. Testing

- **core:** `queries` validation (shape, pointer, caps, additive compat).
- **agent:** `render_view` passes `queries` through; invalid queries return a correctable error string.
- **shell:** web-storage store (round-trip, list ordering, namespace isolation, quota error thrown, malformed-record skip); reopen helper (fresh-data patch, per-query fallback, no-`runQuery` snapshot mode, write-back); prompt-capture helper.
- **demo-bank:** tab persistence + reopen wiring against a fake store/runQuery.
- **Browser verification (mandatory):** `pnpm demo` — generate a data-bound view, reload, reopen, mutate underlying data, confirm fresh render; screenshots in the PR.

## Phasing and the UI gate

- **Phase 1 (this spec):** everything above. No new visual surface.
- **Phase 2 (gated):** the library surface — list, reopen, rename, pin UI. A short UX proposal (placement, states, interactions) goes to Yousef via the orchestrator before any of it is built.

## Open questions for Yousef (bundled into the UI-gate checkpoint)

1. `queries` lives inside `GeneratedPayload` (self-contained artifact, additive to genui/v1). Comfortable, or should provenance live only in the `Flowlet` record outside the payload?
2. localStorage (not IndexedDB) as the embedded reference store — fine for the demo-guarantee role?
3. Should refreshed data write back to the store on reopen (spec says yes, silently)?
