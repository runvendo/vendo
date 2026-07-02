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

type GenData = { payload: { data: Record<string, unknown> } };

describe("refreshFlowletNode", () => {
  it("patches fresh query results into data (status live)", async () => {
    const node = genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]);
    const runQuery: RunQuery = async () => ["fresh"];
    const result = await refreshFlowletNode(node, runQuery);
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
    const result = await refreshFlowletNode(node, runQuery);
    expect(result.status).toBe("partial");
    const data = (result.node as unknown as GenData).payload.data;
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
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <FlowletShellProvider store={store} runQuery={runQuery}>{children}</FlowletShellProvider>
      );
    };

  it("serves the snapshot immediately, then refreshes and writes back", async () => {
    const store = createLocalStore();
    const flowlet = await store.save({
      id: "f1", name: "Tx", prompt: "show tx",
      node: genNode({ tx: ["stale"] }, [{ path: "/tx", tool: "get_transactions" }]),
    });
    const runQuery = vi.fn(async () => ["fresh"]);
    const { result } = renderHook(() => useReopenFlowlet(flowlet), { wrapper: wrap(store, runQuery) });
    expect(result.current.status).toBe("snapshot"); // instant
    await waitFor(() => expect(result.current.status).toBe("live"));
    await waitFor(async () => {
      const persisted = await store.load("f1");
      expect((persisted!.node as unknown as GenData).payload.data.tx).toEqual(["fresh"]);
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
