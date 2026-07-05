/**
 * Unit tests for MCP ingestion (`ingestMcpTools`) using a fake `McpToolSource`.
 * The real adapter is covered by mcp.contract.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolSet } from "ai";
import { ingestMcpTools, type McpServerConfig, type McpToolSource } from "./mcp";

function fakeSource(
  perServer: Record<
    string,
    { tools: ToolSet; annotations?: Record<string, Record<string, boolean>> } | Error
  >,
): McpToolSource {
  return {
    fetchTools: vi.fn(async (config: McpServerConfig) => {
      const entry = perServer[config.name];
      if (!entry) throw new Error(`unexpected server ${config.name}`);
      if (entry instanceof Error) throw entry;
      return { tools: entry.tools, annotations: entry.annotations ?? {} };
    }),
  };
}

const echoTool = { description: "echo", inputSchema: {}, execute: async () => "ok" };

describe("ingestMcpTools", () => {
  it("fails closed: empty server list returns empty without calling the source", async () => {
    const source = fakeSource({});
    const result = await ingestMcpTools({ servers: [], source });
    expect(result.toolset).toEqual({});
    expect(result.descriptors).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(source.fetchTools).not.toHaveBeenCalled();
  });

  it("prefixes tool names with the server name", async () => {
    const source = fakeSource({ weather: { tools: { get_forecast: echoTool } } });
    const result = await ingestMcpTools({
      servers: [{ name: "weather", url: "http://x" }],
      source,
    });
    expect(Object.keys(result.toolset)).toEqual(["weather_get_forecast"]);
  });

  it("builds descriptors with source 'mcp' and the server-reported annotations", async () => {
    const source = fakeSource({
      weather: {
        tools: { get_forecast: echoTool, purge: echoTool },
        annotations: {
          get_forecast: { readOnlyHint: true },
          purge: { destructiveHint: true },
        },
      },
    });
    const result = await ingestMcpTools({
      servers: [{ name: "weather", url: "http://x" }],
      source,
    });
    const byName = Object.fromEntries(result.descriptors.map((d) => [d.name, d]));
    expect(byName["weather_get_forecast"]!.source).toBe("mcp");
    expect(byName["weather_get_forecast"]!.annotations.readOnlyHint).toBe(true);
    expect(byName["weather_purge"]!.annotations.destructiveHint).toBe(true);
  });

  it("narrows to the per-server allowlist by UNPREFIXED name", async () => {
    const source = fakeSource({
      weather: { tools: { get_forecast: echoTool, purge: echoTool } },
    });
    const result = await ingestMcpTools({
      servers: [{ name: "weather", url: "http://x", tools: ["get_forecast"] }],
      source,
    });
    expect(Object.keys(result.toolset)).toEqual(["weather_get_forecast"]);
  });

  it("tolerates a failing server: warns, records the failure, keeps the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fakeSource({
      broken: new Error("connect refused"),
      weather: { tools: { get_forecast: echoTool } },
    });
    const result = await ingestMcpTools({
      servers: [
        { name: "broken", url: "http://down" },
        { name: "weather", url: "http://x" },
      ],
      source,
    });
    expect(Object.keys(result.toolset)).toEqual(["weather_get_forecast"]);
    expect(result.failures).toEqual(["broken"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MCP server "broken"'));
    warn.mockRestore();
  });

  it("withholds remote error messages entirely for servers sent headers (no token leakage, even transformed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fakeSource({
      // A malicious server can reflect the token base64'd — substring
      // redaction can't catch that, so the whole message must be withheld.
      leaky: new Error(`HTTP 401: ${Buffer.from("Bearer sekrit-token").toString("base64")}`),
    });
    await ingestMcpTools({
      servers: [
        { name: "leaky", url: "http://x", headers: { Authorization: "Bearer sekrit-token" } },
      ],
      source,
    });
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("sekrit-token");
    expect(logged).not.toContain(Buffer.from("Bearer sekrit-token").toString("base64"));
    expect(logged).toContain("message withheld");
    warn.mockRestore();
  });

  it("logs the truncated message for headerless servers (nothing secret was sent)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fakeSource({ open: new Error("connect ECONNREFUSED 127.0.0.1:9") });
    await ingestMcpTools({ servers: [{ name: "open", url: "http://x" }], source });
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("ECONNREFUSED");
    warn.mockRestore();
  });

  it("skips server-returned tool names that are not provider-safe, fail-closed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fakeSource({
      srv: { tools: { "bad name!": echoTool, ok_tool: echoTool } },
    });
    const result = await ingestMcpTools({
      servers: [{ name: "srv", url: "http://x" }],
      source,
    });
    expect(Object.keys(result.toolset)).toEqual(["srv_ok_tool"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tool "bad name!" skipped'));
    warn.mockRestore();
  });

  it("drops ALL claimants of an ambiguous final name (server 'a' tool 'b_c' vs server 'a_b' tool 'c')", async () => {
    // Fail-closed: first-wins would let a malicious earlier server squat a
    // trusted later server's canonical tool name. Nobody gets the name.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fakeSource({
      a: { tools: { b_c: echoTool, safe: echoTool } },
      a_b: { tools: { c: echoTool } },
    });
    const result = await ingestMcpTools({
      servers: [
        { name: "a", url: "http://a" },
        { name: "a_b", url: "http://ab" },
      ],
      source,
    });
    expect(Object.keys(result.toolset)).toEqual(["a_safe"]);
    expect(result.descriptors.map((d) => d.name)).toEqual(["a_safe"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collision on "a_b_c"'));
    warn.mockRestore();
  });

  it("skips a duplicate server name (warns) without recording a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fakeSource({ dup: { tools: { ping: echoTool } } });
    const result = await ingestMcpTools({
      servers: [
        { name: "dup", url: "http://a" },
        { name: "dup", url: "http://b" },
      ],
      source,
    });
    expect(Object.keys(result.toolset)).toEqual(["dup_ping"]);
    expect(result.failures).toEqual([]);
    expect(source.fetchTools).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate MCP server name "dup"'));
    warn.mockRestore();
  });

  it("merges multiple servers; identical unprefixed names cannot collide (prefixes differ)", async () => {
    const source = fakeSource({
      a: { tools: { ping: echoTool } },
      b: { tools: { ping: echoTool } },
    });
    const result = await ingestMcpTools({
      servers: [
        { name: "a", url: "http://a" },
        { name: "b", url: "http://b" },
      ],
      source,
    });
    expect(Object.keys(result.toolset).sort()).toEqual(["a_ping", "b_ping"]);
  });
});
