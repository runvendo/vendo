import type { Json, ToolOutcome, Tree, UIPayload } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import {
  callApp,
  createShimRuntime,
  decodePointer,
  resolveQueries,
  setQueryData,
  type BridgeCallResult,
  type OpenInProductPayload,
  type ServerToolCaller,
} from "../src/tree/mcp-shim/shim-core.js";

const result = (overrides: Partial<BridgeCallResult> = {}): BridgeCallResult => ({
  content: [],
  ...overrides,
});

const callerReturning = (value: BridgeCallResult): ServerToolCaller => vi.fn(async () => value);

describe("MCP Apps shim call mapping", () => {
  it("maps an MCP error result to a joined-text error outcome", async () => {
    const caller = callerReturning(result({
      isError: true,
      content: [
        { type: "text", text: "first detail" },
        { type: "image", data: "ignored", mimeType: "image/png" },
        { type: "text", text: "second detail" },
      ],
    }));

    await expect(callApp(caller, "app_1", "host_lookup", {})).resolves.toEqual({
      status: "error",
      error: { code: "mcp", message: "first detail\nsecond detail" },
    });
  });

  it("prefers structured content over text", async () => {
    const caller = callerReturning(result({
      structuredContent: { source: "structured" },
      content: [{ type: "text", text: JSON.stringify({ source: "text" }) }],
    }));

    await expect(callApp(caller, "app_1", "host_lookup", {})).resolves.toEqual({
      status: "ok",
      output: { source: "structured" },
    });
  });

  it.each([
    ["JSON text", "{\"answer\":42}", { answer: 42 }],
    ["raw text", "not json", "not json"],
    ["empty text", "", null],
  ])("maps %s to the expected output", async (_label, text, output) => {
    const caller = callerReturning(result({
      content: text === "" ? [] : [{ type: "text", text }],
    }));

    await expect(callApp(caller, "app_1", "host_lookup", {})).resolves.toEqual({ status: "ok", output });
  });

  it("passes through ToolOutcome values and wraps all other values", async () => {
    const blocked: ToolOutcome = { status: "blocked", reason: "policy" };
    await expect(callApp(callerReturning(result({ structuredContent: blocked })), "app_1", "host_lookup", {}))
      .resolves.toBe(blocked);
    await expect(callApp(callerReturning(result({ structuredContent: { status: "future" } })), "app_1", "host_lookup", {}))
      .resolves.toEqual({ status: "ok", output: { status: "future" } });
  });

  it("maps thrown transport failures to error outcomes", async () => {
    const caller: ServerToolCaller = vi.fn(async () => { throw new Error("bridge disconnected"); });
    await expect(callApp(caller, "app_1", "host_lookup", {})).resolves.toEqual({
      status: "error",
      error: { code: "mcp", message: "bridge disconnected" },
    });
  });
});

describe("MCP Apps shim query data", () => {
  const query = (path: string, tool = "host_lookup") => ({ path, tool });

  it("decodes the root and JSON Pointer escapes while rejecting unsafe keys", () => {
    expect(decodePointer("")).toEqual([]);
    expect(decodePointer("/a~1b/~0key")).toEqual(["a/b", "~key"]);
    expect(decodePointer("relative")).toBeUndefined();
    for (const key of ["__proto__", "prototype", "constructor"]) {
      expect(decodePointer(`/safe/${key}/value`)).toBeUndefined();
    }
  });

  it("requires an object at the root path and does not mutate prior data", () => {
    const prior = { keep: { nested: true } } satisfies Record<string, Json>;
    const rejected = setQueryData(prior, query(""), [1, 2]);
    expect(rejected).toEqual({
      data: prior,
      error: 'Query "host_lookup" did not return an object for the root data path.',
    });
    expect(prior).toEqual({ keep: { nested: true } });

    const accepted = setQueryData(prior, query(""), { replacement: 1 });
    expect(accepted).toEqual({ data: { replacement: 1 } });
    expect(accepted.data).not.toBe(prior);
    expect(prior).toEqual({ keep: { nested: true } });
  });

  it("creates nested object and array containers based on the next segment", () => {
    const prior = { untouched: true } satisfies Record<string, Json>;
    const updated = setQueryData(prior, query("/groups/0/items/1"), "second");

    expect(updated).toEqual({
      data: {
        untouched: true,
        groups: [{ items: [undefined, "second"] }],
      },
    });
    expect(updated.data).not.toBe(prior);
    expect(prior).toEqual({ untouched: true });
  });

  it("uses decoded pointer segments as object keys", () => {
    expect(setQueryData({}, query("/a~1b/~0key"), 7)).toEqual({
      data: { "a/b": { "~key": 7 } },
    });
  });

  it("rejects non-numeric array path segments", () => {
    const prior = { rows: [] } satisfies Record<string, Json>;
    expect(setQueryData(prior, query("/rows/not-a-number"), 1)).toEqual({
      data: prior,
      error: 'Query "host_lookup" has a non-numeric array path segment.',
    });
    expect(prior).toEqual({ rows: [] });
  });
});

describe("MCP Apps shim query resolution", () => {
  const payload = (queries: Tree["queries"]): UIPayload => ({
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [{ id: "root", component: "Text" }],
    data: { initial: true },
    queries,
  }) as UIPayload;

  it("fans outcomes back into their query paths and renders all failure notices", async () => {
    const calls: string[] = [];
    const outcomes: Record<string, ToolOutcome> = {
      host_ok: { status: "ok", output: 42 },
      host_error: { status: "error", error: { code: "upstream", message: "service unavailable" } },
      host_blocked: { status: "blocked", reason: "policy denied" },
      host_pending: { status: "pending-approval", approvalId: "apr_12345678" },
    };
    const renderPayload = vi.fn();
    await resolveQueries("app_1", payload([
      { path: "/answer", tool: "host_ok", input: { q: 1 } },
      { path: "/error", tool: "host_error" },
      { path: "/blocked", tool: "host_blocked" },
      { path: "/pending", tool: "host_pending" },
    ]), 1, {
      call: async (_id, ref) => {
        calls.push(ref);
        return outcomes[ref]!;
      },
      currentVersion: () => 1,
      renderPayload,
    });

    expect(calls).toEqual(["host_ok", "host_error", "host_blocked", "host_pending"]);
    expect(renderPayload).toHaveBeenCalledWith(
      "app_1",
      expect.anything(),
      { initial: true, answer: 42 },
      [
        'Query "host_error" failed: service unavailable',
        'Query "host_blocked" failed: policy denied',
        'Query "host_pending" failed: waiting for approval apr_12345678',
      ],
    );
  });

  it("discards an older resolution after a newer render starts", async () => {
    let release!: (outcome: ToolOutcome) => void;
    const pending = new Promise<ToolOutcome>((resolve) => { release = resolve; });
    let currentVersion = 1;
    const renderPayload = vi.fn();
    const resolving = resolveQueries("app_old", payload([{ path: "/answer", tool: "host_slow" }]), 1, {
      call: async () => pending,
      currentVersion: () => currentVersion,
      renderPayload,
    });

    currentVersion = 2;
    release({ status: "ok", output: "stale" });
    await resolving;
    expect(renderPayload).not.toHaveBeenCalled();
  });
});

describe("MCP Apps shim open-result flush", () => {
  const openPayload: UIPayload = {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [{ id: "root", component: "Text" }],
  };

  const makeRuntime = () => {
    const renderPayload = vi.fn();
    const renderOpenInProduct = vi.fn();
    const renderNotice = vi.fn();
    const runtime = createShimRuntime({
      callServerTool: callerReturning(result()),
      renderPayload,
      renderOpenInProduct,
      renderNotice,
    });
    return { runtime, renderPayload, renderOpenInProduct, renderNotice };
  };

  it("renders exactly once when the result arrives before the input", () => {
    const { runtime, renderPayload } = makeRuntime();
    runtime.onToolResult({ structuredContent: openPayload });
    expect(renderPayload).not.toHaveBeenCalled();
    runtime.onToolInput({ appId: "app_1" });
    expect(renderPayload).toHaveBeenCalledTimes(1);
  });

  it("renders exactly once when the input arrives before the result", () => {
    const { runtime, renderPayload } = makeRuntime();
    runtime.onToolInput({ appId: "app_1" });
    expect(renderPayload).not.toHaveBeenCalled();
    runtime.onToolResult({ structuredContent: openPayload });
    expect(renderPayload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["result first", true],
    ["input first", false],
  ])("renders a tagged open-in-product result exactly once with the %s ordering", (_label, resultFirst) => {
    const { runtime, renderPayload, renderOpenInProduct, renderNotice } = makeRuntime();
    const open: OpenInProductPayload = {
      kind: "vendo/open-in-product@1",
      url: "https://apps.example/dashboard",
      appName: "Revenue dashboard",
      productName: "Maple",
    };

    if (resultFirst) {
      runtime.onToolResult({ structuredContent: open });
      runtime.onToolInput({ appId: "app_http" });
    } else {
      runtime.onToolInput({ appId: "app_http" });
      runtime.onToolResult({ structuredContent: open });
    }

    expect(renderOpenInProduct).toHaveBeenCalledTimes(1);
    expect(renderOpenInProduct).toHaveBeenCalledWith(open);
    expect(renderPayload).not.toHaveBeenCalled();
    expect(renderNotice).not.toHaveBeenCalled();
  });

  it("renders the invalid-result notice for non-payload structured content", () => {
    const { runtime, renderPayload, renderNotice } = makeRuntime();
    runtime.onToolResult({ structuredContent: { answer: 42 } });
    expect(renderPayload).not.toHaveBeenCalled();
    expect(renderNotice).toHaveBeenCalledWith(
      "Invalid app result",
      "vendo_apps_open did not return a format-tagged UI payload.",
    );
  });
});
