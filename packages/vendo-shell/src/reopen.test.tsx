import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { RegisteredComponent, UINode } from "@vendoai/core";
import { VendoShellProvider } from "./context";
import { createLocalStore, type VendoStore } from "./seams/store";
import type { RunQuery } from "./seams/query";
import { refreshVendoNode, useReopenVendo } from "./reopen";

const genNode = (data: Record<string, unknown>, queries?: unknown): UINode => ({
  id: "view-1",
  kind: "generated",
  payload: {
    formatVersion: "vendo-genui/v1",
    root: "n1",
    nodes: [{ id: "n1", component: "Text", props: { text: { $path: "/tx/0" } } }],
    data,
    ...(queries ? { queries } : {}),
  },
});

type GenData = { payload: { data: Record<string, unknown> } };

describe("refreshVendoNode", () => {
  it("patches fresh query results into data (status live)", async () => {
    const node = genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]);
    const runQuery: RunQuery = async () => ["fresh"];
    const result = await refreshVendoNode(node, runQuery);
    expect(result.status).toBe("live");
    expect((result.node as unknown as GenData).payload.data.tx).toEqual(["fresh"]);
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
    const result = await refreshVendoNode(node, runQuery);
    expect(result.status).toBe("partial");
    const data = (result.node as unknown as GenData).payload.data;
    expect(data.a).toBe(10);
    expect(data.b).toBe(2); // snapshot kept
    expect(result.errors).toHaveLength(1);
  });

  it("treats a non-object result for a root ('') query as a failure, keeping the snapshot", async () => {
    const node = genNode({ v: 1 }, [{ path: "", tool: "weird" }]);
    const result = await refreshVendoNode(node, async () => ["not", "an", "object"]);
    expect(result.status).toBe("snapshot");
    expect(result.errors).toHaveLength(1);
    expect((result.node as unknown as GenData).payload.data).toEqual({ v: 1 });

    const ok = await refreshVendoNode(node, async () => ({ v: 2 }));
    expect(ok.status).toBe("live");
    expect((ok.node as unknown as GenData).payload.data).toEqual({ v: 2 });
  });

  it("is a snapshot no-op without queries or for non-generated nodes", async () => {
    const plain: UINode = { id: "c", kind: "component", source: "prewired", name: "Card", props: {} };
    expect((await refreshVendoNode(plain, async () => 0)).status).toBe("snapshot");
    expect((await refreshVendoNode(genNode({}), async () => 0)).status).toBe("snapshot");
  });
});

describe("useReopenVendo", () => {
  const wrap = (store: VendoStore, runQuery?: RunQuery, refreshIntervalMs = 0) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <VendoShellProvider store={store} runQuery={runQuery} refreshIntervalMs={refreshIntervalMs}>
          {children}
        </VendoShellProvider>
      );
    };

  it("serves the snapshot immediately, then refreshes and writes back", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "Tx", prompt: "show tx",
      node: genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    const runQuery = vi.fn(async () => ["fresh"]);
    const { result } = renderHook(() => useReopenVendo(vendo), { wrapper: wrap(store, runQuery) });
    expect(result.current.status).toBe("snapshot"); // instant
    await waitFor(() => expect(result.current.status).toBe("live"));
    await waitFor(async () => {
      const persisted = await store.load("f1");
      expect((persisted!.node as unknown as GenData).payload.data.tx).toEqual(["fresh"]);
    });
  });

  it("stays a snapshot when no runQuery seam is provided", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "Tx",
      node: genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    const { result } = renderHook(() => useReopenVendo(vendo), { wrapper: wrap(store) });
    expect(result.current.status).toBe("snapshot");
    expect(result.current.refreshing).toBe(false);
  });

  it("write-back merges onto the CURRENT record, preserving a rename during refresh; skips if deleted", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "Old name",
      node: genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => { release = r; });
    const runQuery: RunQuery = () => gate.then(() => ["fresh"]);
    renderHook(() => useReopenVendo(vendo), { wrapper: wrap(store, runQuery) });
    // Rename while the refresh is in flight (what the library UI will do).
    await store.save({ ...(await store.load("f1"))!, name: "New name", updatedAt: undefined as never });
    release(null);
    await waitFor(async () => {
      const persisted = await store.load("f1");
      expect((persisted!.node as unknown as GenData).payload.data.tx).toEqual(["fresh"]);
      expect(persisted!.name).toBe("New name");
    });

    // Deleted while a refresh is in flight → never resurrected.
    const f2 = await store.save({
      id: "f2", name: "Doomed",
      node: genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    let release2!: (v: unknown) => void;
    const gate2 = new Promise((r) => { release2 = r; });
    renderHook(() => useReopenVendo(f2), { wrapper: wrap(store, () => gate2.then(() => ["fresh"])) });
    await store.remove("f2");
    release2(null);
    await new Promise((r) => setTimeout(r, 50));
    expect(await store.load("f2")).toBeNull();
  });

  it("live-refreshes on an interval while visible, patching new data in", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "Tx",
      node: genNode({ tx: [0] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    let call = 0;
    const runQuery = vi.fn(async () => [++call]);
    const { result } = renderHook(() => useReopenVendo(vendo), {
      wrapper: wrap(store, runQuery, 40),
    });
    await waitFor(() => expect(result.current.status).toBe("live"));
    await waitFor(() => expect(runQuery.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    await waitFor(() => {
      const tx = (result.current.node as unknown as GenData).payload.data.tx as number[];
      expect(tx[0]).toBeGreaterThanOrEqual(2);
    });
  });

  it("pauses live refresh while the document is hidden", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "Tx",
      node: genNode({ tx: [0] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    const runQuery = vi.fn(async () => ["fresh"]);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const { result } = renderHook(() => useReopenVendo(vendo), {
        wrapper: wrap(store, runQuery, 30),
      });
      await waitFor(() => expect(result.current.status).toBe("live")); // initial refresh still runs
      const after = runQuery.mock.calls.length;
      await new Promise((r) => setTimeout(r, 150));
      expect(runQuery.mock.calls.length).toBe(after); // no ticks while hidden
    } finally {
      visibility.mockRestore();
    }
  });

  it("stops live refresh after repeated full failures", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "Tx",
      node: genNode({ tx: [0] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    let calls = 0;
    const runQuery = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return ["fresh"]; // initial refresh succeeds
      throw new Error("down");
    });
    renderHook(() => useReopenVendo(vendo), { wrapper: wrap(store, runQuery, 25) });
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(4), { timeout: 3000 }); // 1 ok + 3 failing ticks
    const settled = calls;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(settled); // gave up — no further ticks
  });

  it("ticks patch from the LAST GOOD node — a failed tick never rolls back fresh data", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "Tx",
      node: genNode({ a: "orig", b: "orig" }, [
        { path: "/a", tool: "ta" },
        { path: "/b", tool: "tb" },
      ]),
    });
    let phase = 0; // 0: both succeed; 1+: tb fails
    const runQuery = vi.fn(async (q: { tool: string }) => {
      if (q.tool === "ta") return `a-fresh-${phase}`;
      if (phase === 0) return "b-fresh-0";
      throw new Error("tb down");
    });
    const { result } = renderHook(() => useReopenVendo(vendo), {
      wrapper: wrap(store, runQuery as RunQuery, 40),
    });
    await waitFor(() => expect(result.current.status).toBe("live"));
    phase = 1;
    await waitFor(() => expect(result.current.status).toBe("partial"), { timeout: 3000 });
    const data = (result.current.node as unknown as GenData).payload.data;
    expect(data.b).toBe("b-fresh-0"); // kept from the last GOOD tick, not rolled back to "orig"
  });

  it("a data-equal recovery tick clears the error state (stale note must not stick)", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "Tx",
      node: genNode({ tx: ["same"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    let failing = false;
    const runQuery = vi.fn(async () => {
      if (failing) throw new Error("blip");
      return ["same"]; // data never changes — only availability does
    });
    const { result } = renderHook(() => useReopenVendo(vendo), {
      wrapper: wrap(store, runQuery, 40),
    });
    await waitFor(() => expect(result.current.status).toBe("live"));
    failing = true;
    await waitFor(() => expect(result.current.errors.length).toBeGreaterThan(0), { timeout: 3000 });
    failing = false;
    await waitFor(() => {
      expect(result.current.status).toBe("live");
      expect(result.current.errors).toHaveLength(0);
    }, { timeout: 3000 });
  });

  it("resets refreshing when a new open has nothing to refresh (cancelled in-flight refresh)", async () => {
    const store = createLocalStore();
    const withQueries = await store.save({
      id: "fa", name: "A",
      node: genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    const noQueries = await store.save({ id: "fb", name: "B", node: genNode({}) });
    const never: RunQuery = () => new Promise(() => {});
    const { result, rerender } = renderHook(({ f }) => useReopenVendo(f), {
      wrapper: wrap(store, never),
      initialProps: { f: withQueries },
    });
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    rerender({ f: noQueries });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
  });
});

describe("useReopenVendo — registry drift (ENG-186)", () => {
  const registered = (name: string, version?: string): RegisteredComponent => ({
    name,
    description: "x",
    propsSchema: { "~standard": { version: 1, vendor: "test", validate: (v: unknown) => ({ value: v }) } } as RegisteredComponent["propsSchema"],
    source: "host",
    ...(version !== undefined ? { version } : {}),
  });
  const wrapWith = (store: VendoStore, components?: RegisteredComponent[]) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <VendoShellProvider store={store} refreshIntervalMs={0} components={components}>
          {children}
        </VendoShellProvider>
      );
    };

  it("surfaces missing and version-bumped components from the saved stamp", async () => {
    const store = createLocalStore();
    const vendo = await store.save({
      id: "f1", name: "V", node: genNode({}),
      components: { AcmeOld: "1", AcmeBadge: "1" },
    });
    const { result } = renderHook(() => useReopenVendo(vendo), {
      wrapper: wrapWith(store, [registered("AcmeBadge", "2")]),
    });
    expect(result.current.drift).toEqual({ missing: ["AcmeOld"], changed: ["AcmeBadge"] });
  });

  it("reports no drift for a stamp-free record or when no registry is provided", async () => {
    const store = createLocalStore();
    const stampFree = await store.save({ id: "f1", name: "V", node: genNode({}) });
    const stamped = await store.save({
      id: "f2", name: "W", node: genNode({}), components: { AcmeOld: "1" },
    });
    const a = renderHook(() => useReopenVendo(stampFree), {
      wrapper: wrapWith(store, [registered("AcmeBadge", "9")]),
    });
    expect(a.result.current.drift).toEqual({ missing: [], changed: [] });
    const b = renderHook(() => useReopenVendo(stamped), { wrapper: wrapWith(store) });
    expect(b.result.current.drift).toEqual({ missing: [], changed: [] });
  });
});
