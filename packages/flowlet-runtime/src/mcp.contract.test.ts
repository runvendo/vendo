/**
 * Contract tests for `createMcpToolSource` against the REAL `@ai-sdk/mcp`
 * client, served by a minimal in-process Streamable-HTTP MCP server.
 *
 * Also pins the private-API assumption Yousef approved: the 1.0.6 MCPClient
 * has a runtime `listTools()` (absent from its public type) that carries the
 * MCP `annotations` the public `tools()` discards. If an SDK bump breaks
 * either fact, these tests fail loudly.
 *
 * Server protocol facts (probe-verified 2026-07-04): notifications must get
 * 202 (a 200 without JSON/SSE content-type throws in the transport); the
 * client opens a GET at startup (inbound SSE) — 405 is tolerated; the
 * initialize reply must echo the client's protocolVersion.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpToolSource } from "./mcp";

const TOOLS = [
  {
    name: "get_forecast",
    description: "Read the forecast",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "purge_cache",
    description: "Destroy the cache",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: true },
  },
];

let server: Server;
let url: string;
const seenAuthHeaders: Array<string | undefined> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== "POST") {
      // The client opens a GET (inbound SSE) at startup; 405 is tolerated.
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seenAuthHeaders.push(req.headers["authorization"]);
      const msg = raw
        ? (JSON.parse(raw) as {
            id?: number;
            method: string;
            params?: { protocolVersion?: string; name?: string };
          })
        : { method: "" };
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.id === undefined) {
        // Notification — 202 Accepted (a 200 without JSON/SSE content-type throws).
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "initialize") {
        reply({
          protocolVersion: msg.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        });
        return;
      }
      if (msg.method === "tools/list") {
        reply({ tools: TOOLS });
        return;
      }
      if (msg.method === "tools/call") {
        reply({ content: [{ type: "text", text: `ran:${msg.params?.name}` }] });
        return;
      }
      reply({});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createMcpToolSource (contract, real @ai-sdk/mcp)", () => {
  it("fetches executable tools AND the annotations the public tools() drops", async () => {
    const source = createMcpToolSource();
    const { tools, annotations } = await source.fetchTools({ name: "fake", url });

    expect(Object.keys(tools).sort()).toEqual(["get_forecast", "purge_cache"]);
    // Every SDK-produced MCP tool must be wrappable (has execute) — the
    // fail-closed wrapTool gate depends on this.
    expect(typeof tools["get_forecast"]!.execute).toBe("function");
    // The listTools() cast worked: real MCP annotations came through.
    expect(annotations["get_forecast"]).toEqual({ readOnlyHint: true });
    expect(annotations["purge_cache"]).toEqual({ destructiveHint: true });
  });

  it("sends configured headers on requests", async () => {
    seenAuthHeaders.length = 0;
    const source = createMcpToolSource();
    await source.fetchTools({
      name: "authy",
      url,
      headers: { Authorization: "Bearer sekrit" },
    });
    expect(seenAuthHeaders).toContain("Bearer sekrit");
  });

  it("executes a tool round-trip through the real client", async () => {
    const source = createMcpToolSource();
    const { tools } = await source.fetchTools({ name: "fake", url });
    const result = (await tools["get_forecast"]!.execute!(
      { city: "SF" },
      { toolCallId: "t1", messages: [] },
    )) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toBe("ran:get_forecast");
  });

  it("rejects (so ingest can skip the server) when the server is unreachable", async () => {
    const source = createMcpToolSource();
    await expect(
      source.fetchTools({ name: "down", url: "http://127.0.0.1:1/mcp" }),
    ).rejects.toThrow();
  });
});
