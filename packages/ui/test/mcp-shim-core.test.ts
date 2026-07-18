import type { Json, ToolOutcome, Tree, UIPayload } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import {
  callApp,
  createShimRuntime,
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
  const query = (name: string, tool = "host_lookup") => ({ name, tool });

  it("writes the result at the query's name without mutating prior data (v2 spec §2)", () => {
    const prior = { keep: { nested: true } } satisfies Record<string, Json>;
    const updated = setQueryData(prior, query("answer"), { n: 42 });
    expect(updated).toEqual({ data: { keep: { nested: true }, answer: { n: 42 } } });
    expect(updated.data).not.toBe(prior);
    expect(prior).toEqual({ keep: { nested: true } });
  });

  it("a hostile grammar-legal name becomes own data, never the prototype", () => {
    const updated = setQueryData({}, query("__proto__"), { polluted: true });
    expect(Object.getPrototypeOf(updated.data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(updated.data, "__proto__")?.value).toEqual({ polluted: true });
  });
});

describe("MCP Apps shim open-result flush", () => {
  const openPayload: UIPayload = {
    formatVersion: "vendo-genui/v2",
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
