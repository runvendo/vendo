# ENG-183 Saved Flowlets — Persistence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist generated flowlets (UI tree + declared data queries + originating prompt + name/pin) behind the FlowletStore seam, with a real localStorage embedded store and a reopen flow that re-runs the queries through the policy-governed tool path.

**Architecture:** `GeneratedPayload` gains declared query provenance (`queries`), emitted by `render_view`. The shell gets an extended `Flowlet` record, a `createWebStorage` store, a host-provided `RunQuery` seam, and a reopen helper/hook that patches fresh query results into `data` (the stage adapter's existing data-delta path re-renders in place). demo-bank wires the store, a `runQuery` over `/api/flowlet/action`, and store-backed page tabs. **No new visual surface** — the library UI is gated (Phase 2).

**Tech Stack:** TypeScript, React 18, zod, vitest + Testing Library, pnpm/turbo monorepo.

**Spec:** `docs/superpowers/specs/2026-07-01-flowlet-eng183-saved-flowlets-design.md`

Run all commands from the repo root. Per-package test commands: `pnpm --filter @flowlet/core test`, `--filter @flowlet/agent`, `--filter @flowlet/shell`, `--filter demo-bank` (check exact package names in each `package.json` before first use; demo-bank's is likely `demo-bank`). `pnpm typecheck` covers all.

---

### Task 1: `DataQuery` in the GenUI format (`@flowlet/core`)

**Files:**
- Modify: `packages/flowlet-core/src/genui/format.ts`
- Test: `packages/flowlet-core/src/genui/format.test.ts`

- [ ] **Step 1: Write failing tests** — append to the existing `describe("validateGeneratedPayload")` in `format.test.ts` (reuse the file's `minimal()` helper):

```ts
it("accepts a payload with valid queries", () => {
  const result = validateGeneratedPayload({
    ...(minimal() as object),
    data: { tx: [] },
    queries: [{ path: "/tx", tool: "get_transactions", input: { limit: 40 } }],
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.payload.queries).toHaveLength(1);
});

it("accepts an empty-pointer query path and an input-less query", () => {
  const result = validateGeneratedPayload({
    ...(minimal() as object),
    queries: [{ path: "", tool: "get_transactions" }],
  });
  expect(result.ok).toBe(true);
});

it("rejects malformed queries with provision", () => {
  const bads: unknown[] = [
    "nope",                                            // not an array
    [{ path: "tx", tool: "t" }],                       // pointer missing leading /
    [{ path: "/tx", tool: "" }],                       // empty tool
    [{ path: "/tx", tool: "t", input: "x" }],          // non-object input
    [{ path: "/tx" }],                                 // missing tool
    Array.from({ length: MAX_GENUI_QUERIES + 1 }, () => ({ path: "/t", tool: "t" })), // over cap
  ];
  for (const queries of bads) {
    const result = validateGeneratedPayload({ ...(minimal() as object), queries });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  }
});
```

Also add `MAX_GENUI_QUERIES` to the import list from `./format`.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @flowlet/core test -- format` → FAIL (`MAX_GENUI_QUERIES` not exported; queries silently accepted).

- [ ] **Step 3: Implement** in `format.ts`:

Add after the `PropBinding` block:

```ts
/** Declared provenance of a `data` subtree: the tool call that produced it.
 *  Reopening a saved view re-runs these through the normal (policy-governed)
 *  tool path and patches results back in at `path`. */
export interface DataQuery {
  /** RFC 6901 JSON Pointer into `data`; "" replaces the whole model. */
  path: string;
  tool: string;
  input?: Record<string, unknown>;
}
```

Add `queries?: DataQuery[];` to `GeneratedPayload` (after `data`). Add next to the other caps:

```ts
/** Cap on declared data queries (consistent with MAX_GENUI_NODES defense). */
export const MAX_GENUI_QUERIES = 16;
```

Add validation in `validateGeneratedPayload`, right after the `data` check:

```ts
if (input.queries !== undefined) {
  if (!Array.isArray(input.queries)) return fail("provision", "queries must be an array");
  if (input.queries.length > MAX_GENUI_QUERIES) {
    return fail("provision", `too many queries (max ${MAX_GENUI_QUERIES})`);
  }
  for (const q of input.queries) {
    if (!isPlainObject(q)) return fail("provision", "each query must be an object");
    if (typeof q.path !== "string" || (q.path !== "" && q.path[0] !== "/")) {
      return fail("provision", "query path must be a JSON Pointer ('' or starting with '/')");
    }
    if (typeof q.tool !== "string" || q.tool.length === 0) {
      return fail("provision", "query tool must be a non-empty string");
    }
    if (q.input !== undefined && !isPlainObject(q.input)) {
      return fail("provision", "query input must be a plain object");
    }
  }
}
```

Confirm `DataQuery` is exported from the package root (check `packages/flowlet-core/src/genui/index.ts` re-exports `./format` types; add `DataQuery` if the file lists exports explicitly).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @flowlet/core test -- format` → PASS.

- [ ] **Step 5: Commit** — `git add packages/flowlet-core && git commit -m "feat(core): declared data queries in GenUI payloads (ENG-183)"`

---

### Task 2: `render_view` emits queries (`@flowlet/agent`)

**Files:**
- Modify: `packages/flowlet-agent/src/render-view-tool.ts`
- Test: `packages/flowlet-agent/src/render-view-tool.test.ts`

- [ ] **Step 1: Write failing tests** (follow the file's existing writer-mock pattern — read the top of the test file first and reuse its helpers for constructing the tool + capturing `writer.write` calls):

```ts
it("passes declared queries through to the shipped payload", async () => {
  // build tool with mock writer per existing pattern
  const result = await tool.execute!({
    formatVersion: "flowlet-genui/v1",
    root: "n1",
    nodes: [{ id: "n1", component: "Text", props: { text: { $path: "/tx/0/merchant" } } }],
    data: { tx: [{ merchant: "DoorDash" }] },
    queries: [{ path: "/tx", tool: "get_transactions", input: { limit: 40 } }],
  }, opts);
  expect(result).toBe("rendered");
  const node = writtenNodes.at(-1); // the data-ui node captured from writer.write
  expect((node.payload as { queries: unknown[] }).queries).toHaveLength(1);
});

it("returns a correctable error for malformed queries", async () => {
  const result = await tool.execute!({
    formatVersion: "flowlet-genui/v1",
    root: "n1",
    nodes: [{ id: "n1", component: "Text" }],
    queries: [{ path: "no-slash", tool: "t" }],
  }, opts);
  expect(String(result)).toMatch(/render_view error \(provision\)/);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @flowlet/agent test -- render-view` → the passthrough test FAILS (zod strips the undeclared `queries` key).

- [ ] **Step 3: Implement** in `render-view-tool.ts` — add above `createRenderViewTool`:

```ts
const dataQuerySchema = z.object({
  path: z.string().describe("JSON Pointer into `data` where this tool's result lives ('' = the whole model)."),
  tool: z.string().describe("Name of the tool whose call produced the data at `path`."),
  input: z.record(z.string(), z.unknown()).optional()
    .describe("The exact input to replay the tool with on refresh."),
});
```

Add to `inputSchema`'s object, after `components`:

```ts
queries: z.array(dataQuerySchema).optional()
  .describe("Provenance of `data` for refreshable views: which policy-governed tool calls produced it. " +
    "Place each tool's result VERBATIM at its `path` in `data` (transform inside generated components, " +
    "not between tool and data). Reopening a saved view re-runs these to fetch fresh data."),
```

No `execute` change needed — `validateGeneratedPayload` (Task 1) already validates `queries`, and the validated payload ships whole.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @flowlet/agent test -- render-view` → PASS.

- [ ] **Step 5: Commit** — `git add packages/flowlet-agent && git commit -m "feat(agent): render_view accepts declared data queries (ENG-183)"`

---

### Task 3: Extended `Flowlet` record (`@flowlet/shell` store seam)

**Files:**
- Modify: `packages/flowlet-shell/src/seams/store.ts`
- Test: `packages/flowlet-shell/src/seams/store.test.ts`

- [ ] **Step 1: Write failing test** — append to `store.test.ts`:

```ts
it("carries prompt/pinned and stamps createdAt once", async () => {
  const store = createLocalStore();
  const first = await store.save({ id: "f1", name: "Spending", node, prompt: "show my spending", pinned: true });
  expect(first.prompt).toBe("show my spending");
  expect(first.pinned).toBe(true);
  expect(typeof first.createdAt).toBe("number");
  const renamed = await store.save({ ...first, name: "Late-night spending", updatedAt: undefined });
  expect(renamed.createdAt).toBe(first.createdAt);      // rename keeps identity
  expect(renamed.updatedAt).toBeGreaterThan(first.updatedAt);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @flowlet/shell test -- seams/store` → FAIL (type error / missing createdAt).

- [ ] **Step 3: Implement** in `store.ts`:

```ts
/** A saved flowlet per architecture Decision 6: tree + provenance + name/pin.
 *  The bound data queries live INSIDE a generated node's payload (`queries`). */
export interface Flowlet {
  id: string;
  name: string;
  node: UINode;
  /** The user prompt that originally produced the view. */
  prompt?: string;
  pinned?: boolean;
  /** Stamped by the store on first save; preserved on later saves. */
  createdAt?: number;
  updatedAt: number;
}
```

In `createLocalStore().save`:

```ts
async save(draft) {
  const updatedAt = draft.updatedAt ?? ++clock;
  const createdAt = draft.createdAt ?? map.get(draft.id)?.createdAt ?? updatedAt;
  const flowlet: Flowlet = { ...draft, createdAt, updatedAt };
  map.set(flowlet.id, flowlet);
  return flowlet;
},
```

(`FlowletDraft` needs no change; passing `updatedAt: undefined` explicitly is fine under `??`. If the repo's tsconfig has `exactOptionalPropertyTypes`, spread-drop `updatedAt` in the test instead.)

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @flowlet/shell test -- seams/store` → PASS.

- [ ] **Step 5: Commit** — `git add packages/flowlet-shell && git commit -m "feat(shell): extend Flowlet record with prompt/pinned/createdAt (ENG-183)"`

---

### Task 4: `createWebStorage` — the real embedded store

**Files:**
- Create: `packages/flowlet-shell/src/seams/web-storage.ts`
- Test: `packages/flowlet-shell/src/seams/web-storage.test.ts`
- Modify: `packages/flowlet-shell/src/index.ts` (export), `packages/flowlet-shell/src/exports.test.ts` (if it asserts the export list, add `createWebStorage`)

- [ ] **Step 1: Write failing tests** — `web-storage.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { UINode } from "@flowlet/core";
import { createWebStorage } from "./web-storage";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

/** Minimal in-memory Storage (jsdom-free). */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("createWebStorage", () => {
  it("round-trips a flowlet and lists newest-first", async () => {
    let t = 0;
    const store = createWebStorage({ storage: fakeStorage(), now: () => ++t });
    await store.save({ id: "a", name: "A", node, prompt: "make A" });
    await store.save({ id: "b", name: "B", node });
    const list = await store.list();
    expect(list.map((f) => f.id)).toEqual(["b", "a"]);
    expect((await store.load("a"))?.prompt).toBe("make A");
  });

  it("keeps createdAt across rename saves and removes cleanly", async () => {
    let t = 0;
    const store = createWebStorage({ storage: fakeStorage(), now: () => ++t });
    const first = await store.save({ id: "a", name: "A", node });
    const renamed = await store.save({ id: "a", name: "A2", node });
    expect(renamed.createdAt).toBe(first.createdAt);
    await store.remove("a");
    expect(await store.load("a")).toBeNull();
  });

  it("isolates namespaces over the same storage", async () => {
    const storage = fakeStorage();
    const s1 = createWebStorage({ storage, namespace: "u1" });
    const s2 = createWebStorage({ storage, namespace: "u2" });
    await s1.save({ id: "a", name: "A", node });
    expect(await s2.list()).toHaveLength(0);
  });

  it("skips malformed records with a warning, and lets quota errors throw", async () => {
    const storage = fakeStorage();
    storage.setItem("flowlet:saved:default:bad", "{not json");
    const store = createWebStorage({ storage });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await store.list()).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();

    const full: Storage = { ...fakeStorage(), setItem: () => { throw new Error("QuotaExceeded"); } };
    const failing = createWebStorage({ storage: full });
    await expect(failing.save({ id: "x", name: "X", node })).rejects.toThrow(/Quota/);
  });

  it("throws a clear error when no storage exists (SSR)", async () => {
    const store = createWebStorage({ storage: undefined });
    // simulate no globalThis.localStorage by stubbing it away
    vi.stubGlobal("localStorage", undefined);
    await expect(store.list()).rejects.toThrow(/web storage unavailable/);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @flowlet/shell test -- web-storage` → FAIL (module missing).

- [ ] **Step 3: Implement** — `web-storage.ts`:

```ts
import type { Flowlet, FlowletStore } from "./store";

export interface WebStorageOptions {
  /** Scope records (e.g. per user). Default "default". */
  namespace?: string;
  /** Injectable for tests/SSR; defaults to globalThis.localStorage at call time. */
  storage?: Storage;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
}

/**
 * The real embedded-mode FlowletStore over Web Storage (ENG-183). One key per
 * record under `flowlet:saved:<namespace>:`. Failures are loud: an unavailable
 * or full storage throws — persistence must never silently no-op.
 */
export function createWebStorage(options: WebStorageOptions = {}): FlowletStore {
  const { namespace = "default", now = Date.now } = options;
  const prefix = `flowlet:saved:${namespace}:`;
  const keyOf = (id: string) => prefix + id;

  const storage = (): Storage => {
    const s = options.storage ?? (globalThis as { localStorage?: Storage }).localStorage;
    if (!s) throw new Error("[flowlet] web storage unavailable in this environment");
    return s;
  };

  const read = (key: string): Flowlet | null => {
    const raw = storage().getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as Flowlet;
    } catch {
      console.warn(`[flowlet] skipping malformed saved flowlet at "${key}"`);
      return null;
    }
  };

  return {
    async list() {
      const s = storage();
      const out: Flowlet[] = [];
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key !== null && key.startsWith(prefix)) {
          const flowlet = read(key);
          if (flowlet) out.push(flowlet);
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async load(id) {
      return read(keyOf(id));
    },
    async save(draft) {
      const updatedAt = draft.updatedAt ?? now();
      const createdAt = draft.createdAt ?? read(keyOf(draft.id))?.createdAt ?? updatedAt;
      const flowlet: Flowlet = { ...draft, createdAt, updatedAt };
      // Quota/security errors propagate to the caller — loud by design.
      storage().setItem(keyOf(draft.id), JSON.stringify(flowlet));
      return flowlet;
    },
    async remove(id) {
      storage().removeItem(keyOf(id));
    },
  };
}
```

Export from `index.ts` next to the store seam: `export * from "./seams/web-storage";`. If `exports.test.ts` enumerates exports, add `createWebStorage`.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @flowlet/shell test -- web-storage exports` → PASS.

- [ ] **Step 5: Commit** — `git add packages/flowlet-shell && git commit -m "feat(shell): createWebStorage — real embedded FlowletStore (ENG-183)"`

---

### Task 5: `RunQuery` seam + reopen refresh helper + prompt capture

**Files:**
- Create: `packages/flowlet-shell/src/seams/query.ts`
- Create: `packages/flowlet-shell/src/reopen.ts`
- Create: `packages/flowlet-shell/src/reopen.test.ts` (pure-helper tests) and `packages/flowlet-shell/src/reopen.test.tsx` (hook test) — or one `.tsx` file for both
- Modify: `packages/flowlet-shell/src/context.tsx` (optional `runQuery` on provider/context), `packages/flowlet-shell/src/use-flowlet-thread.ts` (`originatingPrompt`), `packages/flowlet-shell/src/index.ts` (exports)
- Test: append to `packages/flowlet-shell/src/use-flowlet-thread.test.ts`

- [ ] **Step 1: Write failing tests** — `reopen.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { UINode } from "@flowlet/core";
import { FlowletShellProvider } from "./context";
import { createLocalStore, type FlowletStore } from "./seams/store";
import type { RunQuery } from "./seams/query";
import { refreshFlowletNode, useReopenFlowlet } from "./reopen";

const genNode = (data: Record<string, unknown>, queries?: unknown): UINode => ({
  id: "view-1",
  kind: "generated",
  payload: {
    formatVersion: "flowlet-genui/v1",
    root: "n1",
    nodes: [{ id: "n1", component: "Text", props: { text: { $path: "/tx/0" } } }],
    data,
    ...(queries ? { queries } : {}),
  },
});

describe("refreshFlowletNode", () => {
  it("patches fresh query results into data (status live)", async () => {
    const node = genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]);
    const runQuery: RunQuery = async () => ["fresh"];
    const result = await refreshFlowletNode(node, runQuery);
    expect(result.status).toBe("live");
    expect((result.node as { payload: { data: { tx: string[] } } }).payload.data.tx).toEqual(["fresh"]);
  });

  it("falls back to the snapshot per failed query", async () => {
    const node = genNode({ a: 1, b: 2 }, [
      { path: "/a", tool: "ok" },
      { path: "/b", tool: "boom" },
    ]);
    const runQuery: RunQuery = async (q) => {
      if (q.tool === "boom") throw new Error("denied");
      return 10;
    };
    const result = await refreshFlowletNode(node, runQuery);
    expect(result.status).toBe("partial");
    const data = (result.node as { payload: { data: Record<string, unknown> } }).payload.data;
    expect(data.a).toBe(10);
    expect(data.b).toBe(2); // snapshot kept
    expect(result.errors).toHaveLength(1);
  });

  it("is a snapshot no-op without queries or for non-generated nodes", async () => {
    const plain: UINode = { id: "c", kind: "component", source: "prewired", name: "Card", props: {} };
    expect((await refreshFlowletNode(plain, async () => 0)).status).toBe("snapshot");
    expect((await refreshFlowletNode(genNode({}), async () => 0)).status).toBe("snapshot");
  });
});

describe("useReopenFlowlet", () => {
  const wrap = (store: FlowletStore, runQuery?: RunQuery) =>
    ({ children }: { children: ReactNode }) => (
      <FlowletShellProvider store={store} runQuery={runQuery}>{children}</FlowletShellProvider>
    );

  it("serves the snapshot immediately, then refreshes and writes back", async () => {
    const store = createLocalStore();
    const flowlet = await store.save({
      id: "f1", name: "Tx", prompt: "show tx",
      node: genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    const runQuery = vi.fn<RunQuery>(async () => ["fresh"]);
    const { result } = renderHook(() => useReopenFlowlet(flowlet), { wrapper: wrap(store, runQuery) });
    expect(result.current.status).toBe("snapshot"); // instant
    await waitFor(() => expect(result.current.status).toBe("live"));
    await waitFor(async () => {
      const persisted = await store.load("f1");
      expect((persisted!.node as { payload: { data: { tx: string[] } } }).payload.data.tx).toEqual(["fresh"]);
    });
  });

  it("stays a snapshot when no runQuery seam is provided", async () => {
    const store = createLocalStore();
    const flowlet = await store.save({
      id: "f1", name: "Tx",
      node: genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    const { result } = renderHook(() => useReopenFlowlet(flowlet), { wrapper: wrap(store) });
    expect(result.current.status).toBe("snapshot");
    expect(result.current.refreshing).toBe(false);
  });
});
```

And in `use-flowlet-thread.test.ts` append:

```ts
it("originatingPrompt finds the nearest preceding user text", () => {
  const items = [
    { kind: "text", key: "m1:0", messageId: "m1", role: "user", text: "show my spending" },
    { kind: "text", key: "m2:0", messageId: "m2", role: "assistant", text: "sure" },
    { kind: "ui", key: "m2:1", messageId: "m2", node: { id: "v", kind: "generated", payload: {} } },
  ] as ThreadItem[];
  expect(originatingPrompt(items, "m2:1")).toBe("show my spending");
  expect(originatingPrompt(items, "missing")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @flowlet/shell test -- reopen use-flowlet-thread` → FAIL (modules/exports missing).

- [ ] **Step 3: Implement**

`seams/query.ts`:

```ts
import type { DataQuery } from "@flowlet/core";

/**
 * Host-provided execution seam for reopening saved views: run one declared
 * data query through the host's normal (policy-governed) tool path and return
 * the tool result. Same shape as a stage ActionRequest on purpose — in
 * embedded demo-bank this is one fetch to /api/flowlet/action.
 */
export type RunQuery = (query: DataQuery) => Promise<unknown>;
```

`reopen.ts`:

```ts
import { useEffect, useState } from "react";
import {
  applyPointerPatch,
  isGeneratedNode,
  type DataQuery,
  type GeneratedPayload,
  type UINode,
} from "@flowlet/core";
import type { Flowlet } from "./seams/store";
import type { RunQuery } from "./seams/query";
import { useShell } from "./context";

export type RefreshStatus = "live" | "partial" | "snapshot";

export interface RefreshResult {
  node: UINode;
  status: RefreshStatus;
  errors: { query: DataQuery; error: unknown }[];
}

/** The declared queries of a saved node ([] when none / not generated). */
export function flowletQueries(node: UINode): DataQuery[] {
  if (!isGeneratedNode(node)) return [];
  return (node.payload as GeneratedPayload).queries ?? [];
}

/**
 * Re-run a saved view's declared queries and patch fresh results into its data
 * model. Per-query failures keep the snapshot for that path (graceful fallback);
 * the tree itself never changes, so the stage re-renders via data deltas.
 */
export async function refreshFlowletNode(node: UINode, runQuery: RunQuery): Promise<RefreshResult> {
  const queries = flowletQueries(node);
  if (queries.length === 0) return { node, status: "snapshot", errors: [] };

  const payload = node.payload as GeneratedPayload;
  const settled = await Promise.allSettled(queries.map((query) => runQuery(query)));

  let data = (payload.data ?? {}) as Record<string, unknown>;
  const errors: RefreshResult["errors"] = [];
  settled.forEach((outcome, i) => {
    const query = queries[i]!;
    if (outcome.status === "fulfilled") data = applyPointerPatch(data, query.path, outcome.value);
    else errors.push({ query, error: outcome.reason });
  });

  const status: RefreshStatus =
    errors.length === 0 ? "live" : errors.length === queries.length ? "snapshot" : "partial";
  const next: UINode = status === "snapshot" ? node : { ...node, payload: { ...payload, data } };
  return { node: next, status, errors };
}

/**
 * Reopen a saved flowlet: snapshot immediately, then live re-run through the
 * host's RunQuery seam (when provided). A fully-live refresh is written back to
 * the store so the next snapshot is newer; write-back failures only warn.
 */
export function useReopenFlowlet(flowlet: Flowlet): RefreshResult & { refreshing: boolean } {
  const { store, runQuery } = useShell();
  const [result, setResult] = useState<RefreshResult>({ node: flowlet.node, status: "snapshot", errors: [] });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult({ node: flowlet.node, status: "snapshot", errors: [] });
    if (!runQuery || flowletQueries(flowlet.node).length === 0) return;

    setRefreshing(true);
    void refreshFlowletNode(flowlet.node, runQuery)
      .then(async (fresh) => {
        if (cancelled) return;
        setResult(fresh);
        if (fresh.status === "live") {
          const { updatedAt: _prior, ...draft } = flowlet;
          await store.save({ ...draft, node: fresh.node }).catch((error: unknown) => {
            console.warn("[flowlet] refreshed-data write-back failed", error);
          });
        }
      })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
    // Re-run only when a different saved flowlet is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowlet.id, runQuery, store]);

  return { ...result, refreshing };
}
```

`context.tsx` — additive seam: add `runQuery?: RunQuery` to `ShellContextValue` and `FlowletShellProviderProps`, import the type, pass it through the `useMemo` value (and its dep array), destructure it in the component. No behavior change when absent.

`use-flowlet-thread.ts` — append:

```ts
/** The nearest user text item preceding the item with key `uiKey` — i.e. the
 *  prompt that produced a rendered view. Used when saving a flowlet. */
export function originatingPrompt(items: ThreadItem[], uiKey: string): string | undefined {
  const at = items.findIndex((item) => item.key === uiKey);
  if (at < 0) return undefined;
  for (let i = at - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "text" && item.role === "user" && item.text.trim()) return item.text;
  }
  return undefined;
}
```

`index.ts` — add `export * from "./seams/query";` and `export * from "./reopen";` (and update `exports.test.ts` if it enumerates).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @flowlet/shell test` → all shell tests PASS (context tests included — additive change).

- [ ] **Step 5: Commit** — `git add packages/flowlet-shell && git commit -m "feat(shell): RunQuery seam + reopen refresh flow + prompt capture (ENG-183)"`

---

### Task 6: demo-bank wiring — store, runQuery, persistent tabs, agent guidance

**Files:**
- Create: `apps/demo-bank/src/components/flowlet/run-query.ts`
- Create: `apps/demo-bank/src/flowlet/saved-flowlets.ts` + `apps/demo-bank/src/flowlet/saved-flowlets.test.ts`
- Modify: `apps/demo-bank/src/components/flowlet/FlowletRoot.tsx`, `apps/demo-bank/src/app/flowlet/page.tsx`, `apps/demo-bank/src/flowlet/agent.ts`

**Note:** this app's Next.js differs from training data — read the relevant guide in `apps/demo-bank/node_modules/next/dist/docs/` before editing app-router files.

- [ ] **Step 1: Write failing test** — `saved-flowlets.test.ts` for the pure derivation helper:

```ts
import { describe, it, expect } from "vitest";
import type { ThreadItem } from "@flowlet/shell";
import { deriveSavedDrafts } from "./saved-flowlets";

const gen = (id: string): ThreadItem => ({
  kind: "ui", key: `m2:${id}`, messageId: "m2",
  node: { id, kind: "generated", payload: { formatVersion: "flowlet-genui/v1", root: "n1", nodes: [] } },
});

const items: ThreadItem[] = [
  { kind: "text", key: "m1:0", messageId: "m1", role: "user", text: "show my late-night spending" },
  gen("view-1"),
  { kind: "ui", key: "m2:c", messageId: "m2",
    node: { id: "connect-1", kind: "component", source: "host", name: "Connect", props: {} } },
];

describe("deriveSavedDrafts", () => {
  it("captures generated views with their originating prompt, skipping Connect cards and known ids", () => {
    const drafts = deriveSavedDrafts(items, new Set());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: "view-1", prompt: "show my late-night spending" });
    expect(drafts[0]!.name).toBe("show my late-night spending");
    expect(deriveSavedDrafts(items, new Set(["view-1"]))).toHaveLength(0);
  });

  it("truncates long prompts into readable names", () => {
    const long = "please build me a very detailed dashboard about everything I have ever spent money on";
    const drafts = deriveSavedDrafts(
      [{ kind: "text", key: "m1:0", messageId: "m1", role: "user", text: long }, gen("v2")],
      new Set(),
    );
    expect(drafts[0]!.name.length).toBeLessThanOrEqual(48);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter demo-bank test -- saved-flowlets` → FAIL (module missing).

- [ ] **Step 3: Implement**

`src/flowlet/saved-flowlets.ts`:

```ts
/**
 * Pure derivation of saveable flowlets from a thread: every rendered view
 * (generated nodes; host component nodes except the Connect card) becomes a
 * draft, named after the prompt that produced it. The page persists these
 * through the FlowletStore seam (ENG-183).
 */
import type { FlowletDraft, ThreadItem } from "@flowlet/shell";
import { originatingPrompt } from "@flowlet/shell";

const NAME_MAX = 48;

const nameFrom = (prompt: string | undefined, fallback: string): string => {
  const base = prompt?.trim() || fallback;
  return base.length <= NAME_MAX ? base : `${base.slice(0, NAME_MAX - 1).trimEnd()}…`;
};

export function deriveSavedDrafts(items: ThreadItem[], knownIds: ReadonlySet<string>): FlowletDraft[] {
  const drafts: FlowletDraft[] = [];
  for (const item of items) {
    if (item.kind !== "ui") continue;
    const { node } = item;
    if (node.kind === "component" && node.name === "Connect") continue; // auth card, not a view
    if (knownIds.has(node.id) || drafts.some((d) => d.id === node.id)) continue;
    const prompt = originatingPrompt(items, item.key);
    drafts.push({ id: node.id, name: nameFrom(prompt, "Saved view"), node, prompt, pinned: false });
  }
  return drafts;
}
```

`src/components/flowlet/run-query.ts`:

```ts
/**
 * demo-bank's RunQuery seam: replay one declared data query through the SAME
 * policy-governed action route the sandbox uses. Reads are ALWAYS_ALLOW in the
 * demo policy; anything approval-gated or denied throws, and the reopen flow
 * falls back to the saved snapshot.
 */
import type { DataQuery } from "@flowlet/core";

export async function runQuery(query: DataQuery): Promise<unknown> {
  const res = await fetch("/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: query.tool, payload: query.input ?? {} }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `query failed (${res.status})`);
  if (json.needsApproval === true) throw new Error(`query "${query.tool}" requires approval`);
  return json.result;
}
```

`FlowletRoot.tsx` — add imports and pass the store + seam (module-scope store keeps one instance; it touches localStorage lazily so SSR-safe):

```tsx
import { createWebStorage } from "@flowlet/shell";
import { runQuery } from "./run-query";

const store = createWebStorage({ namespace: "maple-demo" });
// in JSX:
<FlowletShellProvider
  renderNode={renderNode}
  integrations={integrations}
  store={store}
  runQuery={runQuery}
  ...
```

`src/app/flowlet/page.tsx` — replace the in-state `saved` tabs with store-backed persistence (keep the exact same tab-strip markup and classes; **no visual changes**):

```tsx
// replace the SavedTab interface + labelFor + the setSaved effect with:
import { useShell, useReopenFlowlet, type Flowlet } from "@flowlet/shell"
import { deriveSavedDrafts } from "@/flowlet/saved-flowlets"

// inside PageSurface:
const { store } = useShell()
const [saved, setSaved] = useState<Flowlet[]>([])

// hydrate the tab strip from the store once on mount
useEffect(() => {
  let cancelled = false
  void store.list().then((all) => { if (!cancelled) setSaved(all.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) })
  return () => { cancelled = true }
}, [store])

// persist every newly rendered view through the store (was: setSaved append)
useEffect(() => {
  const drafts = deriveSavedDrafts(chat.items, new Set(saved.map((s) => s.id)))
  if (drafts.length === 0) return
  void Promise.all(drafts.map((d) => store.save(d))).then((records) => {
    setSaved((prev) => [...prev, ...records])
  })
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [chat.items])

// tab rendering: s.label becomes s.name
// the saved pane re-runs queries on open:
const activeSaved = saved.find((s) => s.id === active)
...
{activeSaved ? <SavedPane key={activeSaved.id} flowlet={activeSaved} /> : null}

// new component in the same file:
function SavedPane({ flowlet }: { flowlet: Flowlet }) {
  const { renderNode } = useShell()
  const { node } = useReopenFlowlet(flowlet)
  return <div className="fl-saved-pane">{renderNode(node)}</div>
}
```

(The saved pane renders the snapshot instantly; when the refresh lands, the node's `data` changes and the stage adapter streams prop deltas in place. `errors`/`status` are deliberately not surfaced visually pre-UI-gate.)

`src/flowlet/agent.ts` — in `buildInstructions()`, insert after the "HOW render_view WORKS" block:

```ts
"REFRESHABLE VIEWS — when a view presents data you fetched with a tool, make it",
"re-runnable: put the tool's result VERBATIM at one path in `data` (e.g.",
"data.transactions = the exact get_transactions output), bind props into that",
"subtree with { $path } or transform it inside a generated component, and declare",
"queries: [{ path: '/transactions', tool: 'get_transactions', input: { limit: 40 } }].",
"Saved views re-run those queries on reopen to show fresh data. Do NOT reshape",
"tool output before storing it at the declared path — reshape at render time.",
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter demo-bank test` → PASS (new helper test + existing suites).

- [ ] **Step 5: Commit** — `git add apps/demo-bank && git commit -m "feat(demo-bank): persist flowlet tabs via web storage; reopen re-runs queries (ENG-183)"`

---

### Task 7: Full verification

- [ ] **Step 1:** `pnpm typecheck && pnpm test && pnpm lint` from the root → all green. Fix anything that isn't (the shell exports test and context tests are the likely tripwires).
- [ ] **Step 2:** Browser verification (verification-before-completion + verify skill): `pnpm demo`, then in the app: (1) ask for a data-bound view ("show my spending by time of day"), confirm a tab appears; (2) reload the page — tab survives; (3) open the tab — view renders from snapshot, network shows a POST to `/api/flowlet/action` re-running the query, view updates; (4) screenshot the tab strip + reopened view for the PR. Confirm the `[flowlet] No store prop` warning is GONE from the console.
- [ ] **Step 3:** Commit any fixes; update the Orca worktree comment (persistence layer done, entering UI gate).

---

## Self-review notes

- Spec §1→Tasks 1–2, §2→Task 3, §3→Task 4, §4→Task 5, §5→Task 6, §6→Tasks 1–7 (tests) — covered.
- Type names used across tasks: `DataQuery`, `MAX_GENUI_QUERIES` (core); `Flowlet`, `FlowletDraft`, `createWebStorage`, `RunQuery`, `refreshFlowletNode`, `useReopenFlowlet`, `flowletQueries`, `originatingPrompt`, `deriveSavedDrafts` — consistent.
- Deliberately NOT in this plan (Phase 2, UI-gated): library surface (list/reopen/rename/pin UI), stale-data indicator, FlowletSlot store-seam alignment.
