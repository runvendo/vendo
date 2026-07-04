# Flowlet MCP Client Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host-declared remote MCP servers become policy-governed agent tools, per the approved spec `docs/superpowers/specs/2026-07-04-flowlet-mcp-client-design.md`.

**Architecture:** A new runtime ingestion module (`mcp.ts`) mirroring `composio.ts` — injectable `McpToolSource` seam wrapping `@ai-sdk/mcp@1.0.6`'s `createMCPClient`, tools prefixed `<serverName>_<toolName>`, wired into the engine as the F2-reserved 4th source (`caller > engine > composio > mcp`) so every tool passes the existing `wrapTool` policy gate. `@flowlet/next` adds `mcpServers` option + `.flowlet/mcp.json` (code overrides file, `${ENV_VAR}` header substitution) and a `capabilities.mcp` flag.

**Tech Stack:** TypeScript, `@ai-sdk/mcp@1.0.6` (already a dependency + on the dependency-guard allowlist), `ai@6.0.28`, zod, vitest.

**Key SDK facts (verified against the installed package, 2026-07-04):**
- `createMCPClient({ transport: { type: "http", url, headers } })` → `Promise<MCPClient>`; `client.tools()` → `ToolSet` where every tool has `execute` and `_meta`.
- **`client.tools()` DISCARDS MCP `annotations`** (uses only `annotations.title`). The runtime class HAS a `listTools()` method returning the raw `tools/list` result (with `annotations`), but it's missing from the 1.0.6 public type. Yousef-approved approach: call it via a narrow structural cast + a contract test that fails loudly if an SDK bump removes it. If the method is absent at runtime, degrade to empty annotations (tools still ingest; policy fail-safes them to "approve").
- The HTTP transport accepts plain `application/json` responses, so the contract test runs a tiny in-process `node:http` JSON-RPC server (no SSE needed). **Probe-verified 2026-07-04** (scratchpad `probe-mcp.mjs`, full handshake + tools + listTools + execute PASSED against the real SDK): JSON-RPC *notifications* must get `202 Accepted` — a `200` with any non-JSON/SSE content-type makes the transport throw `Unexpected content type`. The client also opens a GET (inbound SSE) at startup; reply `405` and it is tolerated. The `initialize` reply must echo the client's requested `protocolVersion`. `tools/call` params carry `arguments` (not `args`), and results come back as `{ content, isError }`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `packages/flowlet-runtime/src/mcp.ts` | Create | `McpServerConfig`, `McpToolSource` seam, `createMcpToolSource` (real adapter), `ingestMcpTools` |
| `packages/flowlet-runtime/src/mcp.test.ts` | Create | Unit tests with a fake `McpToolSource` |
| `packages/flowlet-runtime/src/mcp.contract.test.ts` | Create | Contract test against real `@ai-sdk/mcp` + in-process HTTP server |
| `packages/flowlet-runtime/src/engine.ts` | Modify | `mcp` config field, host-level ingestion cache, 4th source |
| `packages/flowlet-runtime/src/engine.test.ts` | Modify | Engine MCP wiring + precedence tests |
| `packages/flowlet-runtime/src/index.ts` | Modify | Export new symbols |
| `packages/flowlet-next/src/mcp-config.ts` | Create | `mcp.json` zod schema, `${ENV_VAR}` substitution, resolution |
| `packages/flowlet-next/src/mcp-config.test.ts` | Create | Schema/substitution/drop-on-missing tests |
| `packages/flowlet-next/src/flowlet-dir.ts` | Modify | Load `.flowlet/mcp.json` |
| `packages/flowlet-next/src/flowlet-dir.test.ts` | Modify | mcp.json loading tests |
| `packages/flowlet-next/src/options.ts` | Modify | `mcpServers` option + zod |
| `packages/flowlet-next/src/options.test.ts` | Modify | Option validation tests |
| `packages/flowlet-next/src/capabilities.ts` | Modify | `mcp: boolean` on `FlowletCapabilities` |
| `packages/flowlet-next/src/capabilities.test.ts` | Modify | Updated expectations |
| `packages/flowlet-next/src/agent.ts` | Modify | Pass `mcpServers` through to `createFlowletAgent` |
| `packages/flowlet-next/src/handler.ts` | Modify | Resolve servers, capability flag, agent wiring |
| `packages/flowlet-next/src/handler.test.ts` | Modify | Handler-level tests |
| `docs/quickstart.md` | Modify | MCP servers section |

---

### Task 1: Runtime ingestion module — types + `ingestMcpTools` (fake-source TDD)

**Files:**
- Create: `packages/flowlet-runtime/src/mcp.ts`
- Create: `packages/flowlet-runtime/src/mcp.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/flowlet-runtime/src/mcp.test.ts
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

  it("redacts configured header values from failure logs (no token leakage)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fakeSource({
      leaky: new Error("HTTP 401: request had Authorization: Bearer sekrit-token"),
    });
    await ingestMcpTools({
      servers: [
        { name: "leaky", url: "http://x", headers: { Authorization: "Bearer sekrit-token" } },
      ],
      source,
    });
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("sekrit-token");
    expect(logged).toContain("[redacted]");
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

  it("keeps the FIRST tool and warns on ambiguous-prefix collisions (server 'a' tool 'b_c' vs server 'a_b' tool 'c')", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = { description: "first", inputSchema: {}, execute: async () => "first" };
    const source = fakeSource({
      a: { tools: { b_c: first } },
      a_b: { tools: { c: echoTool } },
    });
    const result = await ingestMcpTools({
      servers: [
        { name: "a", url: "http://a" },
        { name: "a_b", url: "http://ab" },
      ],
      source,
    });
    expect(Object.keys(result.toolset)).toEqual(["a_b_c"]);
    expect(result.toolset["a_b_c"]).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collision on "a_b_c"'));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/yousefh/orca/workspaces/flowlet/mcp-client-support && pnpm --filter @flowlet/runtime test -- mcp.test.ts`
Expected: FAIL — `./mcp` module not found.

- [ ] **Step 3: Write the implementation (types + ingest only; real adapter is Task 2)**

```typescript
// packages/flowlet-runtime/src/mcp.ts
/**
 * Host-configured MCP server ingestion for the Flowlet agent runtime.
 *
 * Design: docs/superpowers/specs/2026-07-04-flowlet-mcp-client-design.md.
 * Mirrors the Composio adapter seam: `McpToolSource` is injectable (the real
 * adapter wraps `@ai-sdk/mcp`'s `createMCPClient`; tests inject a fake), and
 * `ingestMcpTools` FAILS CLOSED — no declared servers means no network I/O.
 *
 * MCP servers are host-level (declared by the host developer, shared by all
 * users), unlike Composio's per-user OAuth. Tools are registered as
 * `<serverName>_<toolName>` so provenance is legible and servers can't collide
 * with each other or with other sources.
 */

import type { ToolSet } from "ai";
import { buildDescriptor, type ToolAnnotations, type ToolDescriptor } from "./descriptor";

/** A single host-declared MCP server (Streamable HTTP transport only). */
export interface McpServerConfig {
  /**
   * Prefix for this server's tool names (`<name>_<tool>`). Must be a valid
   * tool-name fragment: letters, digits, `_`, `-`.
   */
  name: string;
  /** The server's Streamable HTTP endpoint (http/https). */
  url: string;
  /** Extra HTTP headers, e.g. `{ Authorization: "Bearer ..." }`. */
  headers?: Record<string, string>;
  /** Optional narrowing allowlist of UNPREFIXED tool names. */
  tools?: string[];
}

/** What one server's fetch yields: executable tools + their MCP annotations. */
export interface McpFetchResult {
  tools: ToolSet;
  /** Per (unprefixed) tool name, the server-reported annotation hints. */
  annotations: Record<string, ToolAnnotations>;
}

/**
 * The Flowlet abstraction over an MCP connection. The real implementation
 * ({@link createMcpToolSource}) wraps `@ai-sdk/mcp`; tests implement it
 * directly.
 */
export interface McpToolSource {
  fetchTools(config: McpServerConfig): Promise<McpFetchResult>;
}

/**
 * Final tool names must be provider-safe: the SDK forwards them verbatim to
 * the model API, and Anthropic caps tool names at `[A-Za-z0-9_-]{1,64}`. A
 * server-returned name that breaks this after prefixing would 400 the WHOLE
 * turn, so invalid names are skipped fail-closed instead.
 */
const VALID_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Sanitize an error for logging. SDK transport errors embed the raw HTTP
 * response body, which a malicious server can use to reflect the request's
 * Authorization header — so never log the error object itself, and redact
 * every configured header value from the message.
 */
function describeError(err: unknown, headers?: Record<string, string>): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const value of Object.values(headers ?? {})) {
    if (value.length > 0) message = message.split(value).join("[redacted]");
  }
  return message.slice(0, 300);
}

/**
 * Ingest tools from host-declared MCP servers.
 *
 * FAILS CLOSED: an empty server list returns empty without touching the
 * source. Per-server fault tolerance: a server that errors is warned about,
 * recorded in `failures`, and skipped — it never breaks other servers or the
 * turn. Callers use `failures` to avoid caching a partial result.
 *
 * Name safety: duplicate final names (duplicate server names, or prefix
 * ambiguity like server "a" tool "b_c" vs server "a_b" tool "c") keep the
 * FIRST registration and warn; server-returned tool names that are not
 * provider-safe are skipped.
 */
export async function ingestMcpTools(args: {
  servers: McpServerConfig[];
  source: McpToolSource;
}): Promise<{ toolset: ToolSet; descriptors: ToolDescriptor[]; failures: string[] }> {
  const { servers, source } = args;

  const toolset: ToolSet = {};
  const descriptors: ToolDescriptor[] = [];
  const failures: string[] = [];

  const seenServers = new Set<string>();
  for (const server of servers) {
    // Duplicate server names would alias each other in the client cache and
    // collide on every prefixed tool name. Deterministic misconfig — warn and
    // skip, but do NOT count as a failure (failures trigger cache retry, and
    // a deterministic one would re-ingest forever).
    if (seenServers.has(server.name)) {
      console.warn(`[flowlet] duplicate MCP server name "${server.name}" skipped.`);
      continue;
    }
    seenServers.add(server.name);

    let fetched: McpFetchResult;
    try {
      fetched = await source.fetchTools(server);
    } catch (err) {
      console.warn(
        `[flowlet] MCP server "${server.name}" skipped: ${describeError(err, server.headers)}`,
      );
      failures.push(server.name);
      continue;
    }

    const allow = server.tools && server.tools.length > 0 ? new Set(server.tools) : null;
    for (const [name, tool] of Object.entries(fetched.tools)) {
      if (allow && !allow.has(name)) continue;
      const prefixed = `${server.name}_${name}`;
      if (!VALID_TOOL_NAME.test(prefixed)) {
        console.warn(
          `[flowlet] MCP server "${server.name}" tool "${name}" skipped: ` +
            "final tool name is not provider-safe.",
        );
        continue;
      }
      if (prefixed in toolset) {
        console.warn(
          `[flowlet] MCP tool name collision on "${prefixed}" ` +
            `(server "${server.name}") — keeping the first registration.`,
        );
        continue;
      }
      toolset[prefixed] = tool;
      descriptors.push(
        buildDescriptor(prefixed, tool, "mcp", fetched.annotations[name] ?? {}),
      );
    }
  }

  return { toolset, descriptors, failures };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @flowlet/runtime test -- mcp.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-runtime/src/mcp.ts packages/flowlet-runtime/src/mcp.test.ts
git commit -m "feat(runtime): MCP ingestion seam — McpToolSource + fail-closed ingestMcpTools"
```

---

### Task 2: Real adapter `createMcpToolSource` + contract test

**Files:**
- Modify: `packages/flowlet-runtime/src/mcp.ts` (append)
- Create: `packages/flowlet-runtime/src/mcp.contract.test.ts`

- [ ] **Step 1: Write the failing contract test**

The in-process server implements just enough Streamable HTTP: JSON-RPC over POST with plain-JSON responses. Notifications (no `id`) get `202 Accepted` (probe-verified; a 200 without a JSON/SSE content-type makes the transport throw). Non-POST requests (the client's startup inbound-SSE GET) get `405` — tolerated. `initialize` echoes the client's `protocolVersion`.

```typescript
// packages/flowlet-runtime/src/mcp.contract.test.ts
/**
 * Contract tests for `createMcpToolSource` against the REAL `@ai-sdk/mcp`
 * client, served by a minimal in-process Streamable-HTTP MCP server.
 *
 * Also pins the private-API assumption Yousef approved: the 1.0.6 MCPClient
 * has a runtime `listTools()` (absent from its public type) that carries the
 * MCP `annotations` the public `tools()` discards. If an SDK bump breaks
 * either fact, these tests fail loudly.
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
      const msg = raw ? (JSON.parse(raw) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string } }) : { method: "" };
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @flowlet/runtime test -- mcp.contract.test.ts`
Expected: FAIL — `createMcpToolSource` is not exported.

- [ ] **Step 3: Implement `createMcpToolSource`**

Append to `packages/flowlet-runtime/src/mcp.ts`:

```typescript
/**
 * The shape of the raw `tools/list` result we need from the SDK's runtime
 * `listTools()` method. In `@ai-sdk/mcp@1.0.6` this method exists on the
 * MCPClient class but is missing from the public interface (it became public
 * in 2.x, which we can't take yet — it targets @ai-sdk/provider@4). The
 * structural cast below is contract-tested in mcp.contract.test.ts.
 */
interface RawListToolsResult {
  tools: Array<{ name: string; annotations?: ToolAnnotations & { title?: string } }>;
}

/**
 * Build the REAL MCP tool source on `@ai-sdk/mcp@1.0.6` (Streamable HTTP
 * transport, static headers — the approved v1 scope).
 *
 * Client lifecycle: one client per server name, created lazily on first fetch
 * and kept open for reuse. A fetch failure closes + evicts that server's
 * client so the next fetch rebuilds the connection, then rethrows so
 * `ingestMcpTools` can skip the server.
 *
 * The public `tools()` gives executable ai-SDK tools but DISCARDS MCP
 * `annotations`; the runtime `listTools()` recovers them. If a future SDK
 * removes `listTools`, we degrade to empty annotations (tools still ingest;
 * the annotation policy then fail-safes every call to "approve").
 */
export function createMcpToolSource(): McpToolSource {
  type Client = {
    tools(): Promise<ToolSet>;
    close(): Promise<void>;
  };
  const clients = new Map<string, Promise<Client>>();

  async function getClient(config: McpServerConfig): Promise<Client> {
    let client = clients.get(config.name);
    if (!client) {
      client = import("@ai-sdk/mcp").then(({ createMCPClient }) =>
        createMCPClient({
          transport: {
            type: "http",
            url: config.url,
            ...(config.headers ? { headers: config.headers } : {}),
          },
        }),
      ) as Promise<Client>;
      clients.set(config.name, client);
    }
    return client;
  }

  return {
    async fetchTools(config) {
      try {
        const client = await getClient(config);
        const tools = await client.tools();

        // Recover the annotations the public API drops (see docstring).
        let annotations: Record<string, ToolAnnotations> = {};
        const maybeListTools = (client as unknown as {
          listTools?: () => Promise<RawListToolsResult>;
        }).listTools;
        if (typeof maybeListTools === "function") {
          const listed = await maybeListTools.call(client);
          annotations = Object.fromEntries(
            listed.tools.map((t) => {
              const { title: _title, ...hints } = t.annotations ?? {};
              return [t.name, hints];
            }),
          );
        } else {
          console.warn(
            `[flowlet] MCP server "${config.name}": SDK listTools() unavailable — ` +
              "annotations unknown, all its tools will require approval.",
          );
        }

        return { tools, annotations };
      } catch (err) {
        // Drop the (possibly dead) client so the next fetch reconnects.
        const stale = clients.get(config.name);
        clients.delete(config.name);
        if (stale) void stale.then((c) => c.close()).catch(() => {});
        throw err;
      }
    },
  };
}
```

- [ ] **Step 4: Run the contract tests to verify they pass**

Run: `pnpm --filter @flowlet/runtime test -- mcp.contract.test.ts`
Expected: PASS (4 tests). If `initialize` fails, debug the fake server against the SDK source at `node_modules/.pnpm/@ai-sdk+mcp@1.0.6_zod@3.25.76/node_modules/@ai-sdk/mcp/dist/index.js` (transport: ~line 1325; supported protocol versions: ~line 78).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-runtime/src/mcp.ts packages/flowlet-runtime/src/mcp.contract.test.ts
git commit -m "feat(runtime): real MCP tool source on @ai-sdk/mcp with annotation recovery + contract tests"
```

---

### Task 3: Engine wiring — `mcp` config, host-level cache, 4th source

**Files:**
- Modify: `packages/flowlet-runtime/src/engine.ts`
- Modify: `packages/flowlet-runtime/src/engine.test.ts`

- [ ] **Step 1: Write the failing engine tests**

Add to `packages/flowlet-runtime/src/engine.test.ts` (follow the existing composio-injection pattern in that file — `mockModel()`, `collect()`, `userTurn`, `allowPolicy` already exist there; import `tool` from `"ai"` and `z` from `"zod"` if not already imported):

```typescript
describe("MCP ingestion wiring", () => {
  // Must be a REAL ai-SDK tool: the engine hands the toolset to streamText,
  // which calls asSchema(tool.inputSchema) — a bare `{}` schema crashes there.
  const echoTool = tool({
    description: "echo",
    inputSchema: z.object({}),
    execute: async () => "ok",
  });

  function fakeMcpSource(result?: { tools: ToolSet; annotations: Record<string, Record<string, boolean>> }) {
    return {
      fetchTools: vi.fn(async () =>
        result ?? { tools: { ping: echoTool }, annotations: { ping: { readOnlyHint: true } } },
      ),
    };
  }

  it("ingests MCP tools once (host-level cache) across runs and principals", async () => {
    const source = fakeMcpSource();
    const agent = createFlowletAgent({
      model: mockModel(),
      policy: allowPolicy,
      mcp: { servers: [{ name: "srv", url: "http://x" }], source },
    });

    await collect(agent.run({ messages: userTurn, tools: {}, principal: { userId: "u1" }, signal: new AbortController().signal }));
    await collect(agent.run({ messages: userTurn, tools: {}, principal: { userId: "u2" }, signal: new AbortController().signal }));

    expect(source.fetchTools).toHaveBeenCalledTimes(1);
  });

  it("retries MCP ingestion on a later run after a failure (failures are not cached)", async () => {
    const source = {
      fetchTools: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ tools: { ping: echoTool }, annotations: {} }),
    };
    const agent = createFlowletAgent({
      model: mockModel(),
      policy: allowPolicy,
      mcp: { servers: [{ name: "srv", url: "http://x" }], source },
    });

    await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));
    await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));

    expect(source.fetchTools).toHaveBeenCalledTimes(2);
  });

  it("does not construct any MCP machinery when config.mcp is absent", async () => {
    // Covered structurally: no `mcp` config → no source built, no fetch.
    // Assert via the module boundary: an agent without mcp runs fine.
    const agent = createFlowletAgent({ model: mockModel(), policy: allowPolicy });
    const parts = await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));
    expect(parts.length).toBeGreaterThan(0);
  });
});
```

Also add a precedence test to `packages/flowlet-runtime/src/toolset.test.ts`-style expectations INSIDE `engine.test.ts` if an equivalent doesn't exist: a caller tool named `srv_ping` and an MCP tool that prefixes to `srv_ping` → the caller wins and a collision warning fires (spy on `console.warn`).

Note: ingestion failures inside a run surface via the engine's per-server tolerance in `ingestMcpTools` — but the test above injects failure at the SOURCE level, which `ingestMcpTools` catches per-server, returning empty. So "retries after failure" must be asserted against the cache: the engine caches the ingestion PROMISE only when it resolves with fetch attempts made. Implementation note (Step 2): because `ingestMcpTools` never rejects (it catches per-server), cache the result only when at least one server succeeded OR cache unconditionally but re-ingest when the previous result was empty-with-servers-declared. Simplest correct rule, mirroring "failures are never cached": **cache the promise; if the resolved toolset is empty while servers were declared, evict after resolution so the next run retries.**

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @flowlet/runtime test -- engine.test.ts`
Expected: FAIL — `mcp` is not a known config property (TS error) / tools not ingested.

- [ ] **Step 3: Implement engine wiring**

In `packages/flowlet-runtime/src/engine.ts`:

1. Import: `import { ingestMcpTools, createMcpToolSource, type McpServerConfig, type McpToolSource } from "./mcp";`
2. Add to `FlowletAgentConfig`:

```typescript
  /** Optional MCP ingestion (host-declared servers). `source` is injectable for tests. */
  mcp?: { servers: McpServerConfig[]; source?: McpToolSource };
```

3. Beside the composio client construction (~line 102):

```typescript
  // MCP tools are HOST-level (declared by the host, shared across users), so
  // one ingestion serves every principal — unlike the per-user Composio cache.
  const mcpSource: McpToolSource | undefined = config.mcp
    ? config.mcp.source ?? createMcpToolSource()
    : undefined;
  let mcpCache: Promise<Ingested> | null = null;
```

4. Inside `execute`, after the composio block (step 3 in the existing numbering):

```typescript
        // 3b. MCP ingestion (fail-closed inside ingestMcpTools; per-server
        //     fault tolerance). Cached host-level: the tools/list round-trip
        //     blocks only the first turn. `ingestMcpTools` never rejects —
        //     instead it reports per-server `failures` — so "failures are
        //     never cached" means: any failed server evicts the cache after
        //     resolution, and the next turn re-ingests (healthy servers are
        //     cheap to re-fetch; their clients stay open in the source).
        let mcpTools: ToolSet = {};
        let mcpDescriptors: Record<string, ToolDescriptor> = {};
        if (config.mcp && mcpSource && config.mcp.servers.length > 0) {
          const servers = config.mcp.servers;
          const source = mcpSource;
          if (!mcpCache) {
            mcpCache = ingestMcpTools({ servers, source }).then((ingested) => {
              if (ingested.failures.length > 0) mcpCache = null;
              return {
                toolset: ingested.toolset,
                descriptors: Object.fromEntries(ingested.descriptors.map((d) => [d.name, d])),
              };
            });
          }
          const ingested = await mcpCache;
          mcpTools = ingested.toolset;
          mcpDescriptors = ingested.descriptors;
        }
```

5. Extend the sources array (F2 precedence — MCP last):

```typescript
        const sources: ToolSourceInput[] = [
          { source: "caller", tools: input.tools ?? {} },
          {
            source: "engine",
            tools: {
              ...config.tools,
              [RENDER_VIEW_TOOL_NAME]: renderViewTool,
              [REQUEST_CONNECT_TOOL_NAME]: requestConnectTool,
            },
          },
          { source: "composio", tools: composioTools, descriptors: composioDescriptors },
          { source: "mcp", tools: mcpTools, descriptors: mcpDescriptors },
        ];
```

- [ ] **Step 4: Run engine tests to verify they pass**

Run: `pnpm --filter @flowlet/runtime test -- engine.test.ts`
Expected: PASS (existing + 3-4 new tests).

- [ ] **Step 5: Export the new symbols**

In `packages/flowlet-runtime/src/index.ts`, next to the composio exports add:

```typescript
export {
  ingestMcpTools,
  createMcpToolSource,
  type McpServerConfig,
  type McpToolSource,
  type McpFetchResult,
} from "./mcp";
```

- [ ] **Step 6: Full runtime package check**

Run: `pnpm --filter @flowlet/runtime test && pnpm --filter @flowlet/runtime typecheck`
Expected: all green (including the dependency-guard test — `@ai-sdk/mcp` is already allowlisted).

- [ ] **Step 7: Commit**

```bash
git add packages/flowlet-runtime/src/engine.ts packages/flowlet-runtime/src/engine.test.ts packages/flowlet-runtime/src/index.ts
git commit -m "feat(runtime): wire MCP as the 4th tool source with host-level ingestion cache"
```

---

### Task 4: `@flowlet/next` — mcp.json schema + env substitution (`mcp-config.ts`)

**Files:**
- Create: `packages/flowlet-next/src/mcp-config.ts`
- Create: `packages/flowlet-next/src/mcp-config.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/flowlet-next/src/mcp-config.test.ts
import { describe, it, expect, vi } from "vitest";
import { mcpJsonSchema, resolveMcpServers } from "./mcp-config";

describe("mcpJsonSchema", () => {
  it("accepts a valid file shape", () => {
    const parsed = mcpJsonSchema.safeParse({
      version: 1,
      servers: [
        { name: "weather", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${WEATHER_TOKEN}" }, tools: ["get_forecast"] },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a server name that is not a valid tool-name fragment", () => {
    expect(mcpJsonSchema.safeParse({ version: 1, servers: [{ name: "bad name!", url: "https://x" }] }).success).toBe(false);
  });

  it("rejects non-http(s) URLs", () => {
    expect(mcpJsonSchema.safeParse({ version: 1, servers: [{ name: "s", url: "file:///etc/passwd" }] }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(mcpJsonSchema.safeParse({ version: 1, servers: [{ name: "s", url: "https://x", transport: "stdio" }] }).success).toBe(false);
  });
});

describe("resolveMcpServers", () => {
  it("substitutes ${ENV_VAR} in header values", () => {
    const resolved = resolveMcpServers(
      [{ name: "s", url: "https://x", headers: { Authorization: "Bearer ${TOK}" } }],
      { TOK: "abc123" },
    );
    expect(resolved).toEqual([{ name: "s", url: "https://x", headers: { Authorization: "Bearer abc123" } }]);
  });

  it("drops a server (with a warning) when a referenced env var is missing or empty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveMcpServers(
      [
        { name: "broken", url: "https://x", headers: { Authorization: "Bearer ${NOPE}" } },
        { name: "ok", url: "https://y" },
      ],
      {},
    );
    expect(resolved.map((s) => s.name)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"broken"'));
    warn.mockRestore();
  });

  it("passes through servers with no headers untouched", () => {
    expect(resolveMcpServers([{ name: "s", url: "https://x", tools: ["a"] }], {})).toEqual([
      { name: "s", url: "https://x", tools: ["a"] },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @flowlet/next test -- mcp-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/flowlet-next/src/mcp-config.ts
/**
 * `.flowlet/mcp.json` schema + resolution for host-declared MCP servers.
 *
 * The file holds the SAME shape as the `mcpServers` handler option, wrapped in
 * a versioned envelope (like tools.json). Header values may reference env vars
 * as `${VAR_NAME}` so tokens never live in the checked-in file. A server whose
 * referenced var is missing/empty is DROPPED with a boot warning — fail
 * closed, never send empty auth.
 *
 * SECURITY INVARIANT: server URLs and header templates come ONLY from the
 * host's code (`mcpServers` option) or its repo (`.flowlet/mcp.json`) — never
 * from request input. The URL schema is deliberately NOT an SSRF guard
 * (localhost/private ranges are legitimate for host-declared servers); any
 * future user-added-server feature MUST add network denylisting before
 * accepting URLs from users.
 */
import { z } from "zod";
import type { McpServerConfig } from "@flowlet/runtime";

/** Matches `<serverName>_<toolName>` tool-name rules (letters, digits, _ , -). */
const NAME_FRAGMENT = /^[A-Za-z0-9_-]+$/;

export const mcpServerSchema = z
  .object({
    name: z.string().regex(NAME_FRAGMENT, "server name must be letters, digits, _ or -"),
    url: z.string().url().refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
      message: "MCP server URL must be http(s)",
    }),
    headers: z.record(z.string()).optional(),
    tools: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Reject duplicate server names — they'd alias each other's tools and clients. */
export const mcpServerArraySchema = z.array(mcpServerSchema).superRefine((servers, ctx) => {
  const seen = new Set<string>();
  for (const s of servers) {
    if (seen.has(s.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate MCP server name "${s.name}"` });
    }
    seen.add(s.name);
  }
});

export const mcpJsonSchema = z
  .object({
    version: z.literal(1),
    servers: mcpServerArraySchema,
  })
  .strict();

export type McpJson = z.infer<typeof mcpJsonSchema>;

const ENV_REF = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Substitute `${VAR}` references in header values from `env`. A server that
 * references a missing/empty var is dropped with a warning.
 */
export function resolveMcpServers(
  servers: McpServerConfig[],
  env: Record<string, string | undefined> = process.env,
): McpServerConfig[] {
  const resolved: McpServerConfig[] = [];
  for (const server of servers) {
    if (!server.headers) {
      resolved.push(server);
      continue;
    }
    let missing: string | null = null;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers)) {
      headers[key] = value.replace(ENV_REF, (_, varName: string) => {
        const v = env[varName];
        if (v === undefined || v.trim() === "") missing = varName;
        return v ?? "";
      });
    }
    if (missing) {
      console.warn(
        `[flowlet] MCP server "${server.name}" dropped: header references env var ` +
          `\${${missing}} which is not set.`,
      );
      continue;
    }
    resolved.push({ ...server, headers });
  }
  return resolved;
}
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm --filter @flowlet/next test -- mcp-config.test.ts`
Expected: PASS.

```bash
git add packages/flowlet-next/src/mcp-config.ts packages/flowlet-next/src/mcp-config.test.ts
git commit -m "feat(next): mcp.json schema + \${ENV_VAR} header substitution with fail-closed drops"
```

---

### Task 5: Load `.flowlet/mcp.json` in `flowlet-dir.ts`

**Files:**
- Modify: `packages/flowlet-next/src/flowlet-dir.ts`
- Modify: `packages/flowlet-next/src/flowlet-dir.test.ts`

- [ ] **Step 1: Write the failing tests**

Follow the existing test file's pattern (it writes temp dirs with theme.json/tools.json). Add:

```typescript
describe("mcp.json", () => {
  it("returns undefined mcpServers when mcp.json is absent (zero-config)", () => {
    const dir = makeDir({}); // helper from the existing tests
    expect(loadFlowletDir(dir).mcpServers).toBeUndefined();
  });

  it("loads and validates mcp.json when present", () => {
    const dir = makeDir({
      "mcp.json": JSON.stringify({
        version: 1,
        servers: [{ name: "weather", url: "https://mcp.example.com/mcp" }],
      }),
    });
    expect(loadFlowletDir(dir).mcpServers).toEqual([
      { name: "weather", url: "https://mcp.example.com/mcp" },
    ]);
  });

  it("fails loud on a present-but-invalid mcp.json", () => {
    const dir = makeDir({ "mcp.json": JSON.stringify({ version: 1, servers: [{ name: "x" }] }) });
    expect(() => loadFlowletDir(dir)).toThrow(/mcp\.json/);
  });
});
```

(If the existing test file's temp-dir helper has a different name/shape, adapt to it — the three behaviors above are what matter: absent → undefined, valid → parsed servers, invalid → loud throw.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @flowlet/next test -- flowlet-dir.test.ts`
Expected: FAIL — `mcpServers` not on `LoadedFlowletDir`.

- [ ] **Step 3: Implement**

In `packages/flowlet-next/src/flowlet-dir.ts`:

```typescript
import { mcpJsonSchema } from "./mcp-config";
import type { McpServerConfig } from "@flowlet/runtime";

export interface LoadedFlowletDir {
  brand: BrandTokens;
  manifest: ToolsManifest;
  /** Raw (pre-env-substitution) servers from mcp.json; absent file → undefined. */
  mcpServers?: McpServerConfig[];
}
```

And in `loadFlowletDir`, after the tools.json block:

```typescript
  const mcpRaw = readJson(path.join(dir, "mcp.json"));
  let mcpServers: McpServerConfig[] | undefined;
  if (mcpRaw !== undefined) {
    const parsed = mcpJsonSchema.safeParse(mcpRaw);
    if (!parsed.success) {
      throw new Error(`mcp.json does not match the MCP servers schema: ${parsed.error.message}`);
    }
    mcpServers = parsed.data.servers;
  }

  return { brand, manifest, ...(mcpServers ? { mcpServers } : {}) };
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm --filter @flowlet/next test -- flowlet-dir.test.ts`

```bash
git add packages/flowlet-next/src/flowlet-dir.ts packages/flowlet-next/src/flowlet-dir.test.ts
git commit -m "feat(next): load .flowlet/mcp.json (absent-safe, loud on invalid)"
```

---

### Task 6: `mcpServers` handler option + `capabilities.mcp`

**Files:**
- Modify: `packages/flowlet-next/src/options.ts`
- Create: `packages/flowlet-next/src/options.test.ts` (does NOT exist yet — option validation is currently covered indirectly; create the file with vitest imports)
- Modify: `packages/flowlet-next/src/capabilities.ts`
- Modify: `packages/flowlet-next/src/capabilities.test.ts`
- Modify: `packages/flowlet-next/src/handler.test.ts` (any exact `capabilities` object assertions gain `mcp: false` — check around line 30)

- [ ] **Step 1: Write the failing tests**

`options.test.ts` (new file):

```typescript
it("accepts mcpServers", () => {
  expect(() =>
    parseHandlerOptions({
      mcpServers: [{ name: "weather", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" }, tools: ["get_forecast"] }],
    }),
  ).not.toThrow();
});

it("rejects an mcpServers entry with a bad name or unknown key", () => {
  expect(() => parseHandlerOptions({ mcpServers: [{ name: "bad name", url: "https://x" }] })).toThrow(/invalid options/);
  expect(() => parseHandlerOptions({ mcpServers: [{ name: "s", url: "https://x", transport: "stdio" } as never] })).toThrow(/invalid options/);
});

it("rejects duplicate MCP server names", () => {
  expect(() =>
    parseHandlerOptions({
      mcpServers: [
        { name: "dup", url: "https://a" },
        { name: "dup", url: "https://b" },
      ],
    }),
  ).toThrow(/invalid options/);
});
```

`capabilities.test.ts` — the interface gains `mcp` (env alone can't detect it; the handler computes it, so `detectCapabilities` reports `false`):

```typescript
it("reports mcp false from env detection (the handler overrides it from resolved config)", () => {
  expect(detectCapabilities({ ANTHROPIC_API_KEY: "k" }).mcp).toBe(false);
});
```

Also update any existing exact-object assertions in `capabilities.test.ts` to include `mcp: false`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @flowlet/next test -- options.test.ts capabilities.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`options.ts`:
- Import: `import { mcpServerSchema } from "./mcp-config";` and `import type { McpServerConfig } from "@flowlet/runtime";`
- Add to `FlowletHandlerOptions` (after `integrations`):

```typescript
  /**
   * Host-declared MCP servers (Streamable HTTP). Tools are ingested through
   * the policy engine as source "mcp", prefixed `<name>_<tool>`. OVERRIDES
   * `.flowlet/mcp.json` entirely when provided.
   */
  mcpServers?: McpServerConfig[];
```

- Add to the zod schema: `mcpServers: mcpServerArraySchema.optional(),` (imported from `./mcp-config` — rejects duplicate names too)

`capabilities.ts`:

```typescript
export interface FlowletCapabilities {
  chat: boolean;
  integrations: boolean;
  voice: boolean;
  /** True when the host declared ≥1 MCP server (set by the handler, not env). */
  mcp: boolean;
}
```

and in `detectCapabilities` return: `mcp: false,` with a comment: `// MCP is config-presence, not key-presence — the handler overrides this.`

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm --filter @flowlet/next test -- options.test.ts capabilities.test.ts`

```bash
git add packages/flowlet-next/src/options.ts packages/flowlet-next/src/options.test.ts packages/flowlet-next/src/capabilities.ts packages/flowlet-next/src/capabilities.test.ts
git commit -m "feat(next): mcpServers option + capabilities.mcp flag"
```

---

### Task 7: Handler + agent-cache wiring

**Files:**
- Modify: `packages/flowlet-next/src/agent.ts`
- Modify: `packages/flowlet-next/src/handler.ts`
- Modify: `packages/flowlet-next/src/handler.test.ts`

- [ ] **Step 1: Write the failing handler tests**

Add to `packages/flowlet-next/src/handler.test.ts` (follow its existing patterns for building a handler and hitting endpoints; `GET /capabilities` responses are plain JSON):

```typescript
describe("mcp wiring", () => {
  it("capabilities.mcp is true when mcpServers option is set", async () => {
    const { GET } = createFlowletHandler({
      mcpServers: [{ name: "weather", url: "https://mcp.example.com/mcp" }],
    });
    const res = await GET(new Request("http://localhost/api/flowlet/capabilities"));
    const body = await res.json();
    expect(body.mcp).toBe(true);
  });

  it("capabilities.mcp is false with no servers declared", async () => {
    const { GET } = createFlowletHandler();
    const res = await GET(new Request("http://localhost/api/flowlet/capabilities"));
    expect((await res.json()).mcp).toBe(false);
  });

  it("capabilities.mcp is false when the only declared server is dropped by env substitution", async () => {
    // Server declared via option with a header referencing a missing var is
    // NOT dropped (option passes through as-is; substitution is file-only) —
    // so this test goes through the flowlet-dir path: point flowletDir at a
    // temp dir whose mcp.json references ${DEFINITELY_NOT_SET_VAR}.
    const dir = writeTempFlowletDir({
      "mcp.json": JSON.stringify({
        version: 1,
        servers: [{ name: "s", url: "https://x", headers: { Authorization: "Bearer ${DEFINITELY_NOT_SET_VAR}" } }],
      }),
    });
    const { GET } = createFlowletHandler({ flowletDir: dir });
    const res = await GET(new Request("http://localhost/api/flowlet/capabilities"));
    expect((await res.json()).mcp).toBe(false);
  });
});
```

(Use/extend the test file's existing temp-dir helper for `writeTempFlowletDir`; if none exists, create the dir with `node:fs` `mkdtempSync` + `writeFileSync` as the flowlet-dir tests do. Note `GET /capabilities` requires the local-request guard — follow how existing handler tests satisfy `resolvePrincipal`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @flowlet/next test -- handler.test.ts`
Expected: FAIL — `mcp` missing from capabilities response.

- [ ] **Step 3: Implement wiring**

`agent.ts` — extend `AgentFactoryConfig` and pass through:

```typescript
import type { McpServerConfig } from "@flowlet/runtime";

export interface AgentFactoryConfig {
  // ... existing fields ...
  /** Host-declared MCP servers (already env-resolved). Empty/undefined = MCP off. */
  mcpServers?: McpServerConfig[];
}
```

In `createAgentCache`'s `createFlowletAgent` call, after the composio spread:

```typescript
        ...(config.mcpServers && config.mcpServers.length > 0
          ? { mcp: { servers: config.mcpServers } }
          : {}),
```

(No cache-key change: the server set is fixed for the handler's lifetime, unlike connected toolkits.)

`handler.ts` — in `assemble()`:

```typescript
import { resolveMcpServers } from "./mcp-config";
```

After `const connections = ...`:

```typescript
    // MCP servers: code option OVERRIDES the file entirely; ${ENV_VAR} header
    // substitution applies only to file-sourced entries (code already runs in
    // an env-aware context). A server whose var is missing is dropped, warned.
    const mcpServers =
      options.mcpServers ?? resolveMcpServers(loaded.mcpServers ?? []);
```

Change the capabilities line:

```typescript
    const capabilities = { ...detectCapabilities(), mcp: mcpServers.length > 0 };
```

And add to the `createAgentCache` call:

```typescript
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @flowlet/next test -- handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Full package check + commit**

Run: `pnpm --filter @flowlet/next test && pnpm --filter @flowlet/next typecheck`

```bash
git add packages/flowlet-next/src/agent.ts packages/flowlet-next/src/handler.ts packages/flowlet-next/src/handler.test.ts
git commit -m "feat(next): wire host-declared MCP servers into the agent + capabilities"
```

---

### Task 8: Docs + repo-wide verification

**Files:**
- Modify: `docs/quickstart.md`

- [ ] **Step 1: Add the MCP section to the quickstart**

After the capability-keys table section, add (match the doc's existing voice — terse, imperative):

```markdown
## MCP servers

Point Flowlet at any remote MCP server and its tools become agent tools, governed by the same approval policy as everything else.

Either declare them in code:

​```ts
export const { GET, POST } = createFlowletHandler({
  mcpServers: [
    {
      name: "weather",                          // tools appear as weather_<tool>
      url: "https://mcp.example.com/mcp",       // Streamable HTTP endpoint
      headers: { Authorization: "Bearer ${...}" }, // optional; put real tokens in code/env
      tools: ["get_forecast"],                  // optional allowlist; omit = all tools
    },
  ],
});
​```

or in `.flowlet/mcp.json` (the code option wins if both exist):

​```json
{
  "version": 1,
  "servers": [
    {
      "name": "weather",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${WEATHER_TOKEN}" }
    }
  ]
}
​```

In `mcp.json`, `${VAR}` in header values is read from the environment at boot; a server whose variable is unset is skipped with a warning. Notes: HTTP transport only (no stdio), static headers only (OAuth-only servers not yet supported), tools only (no resources/prompts). Server-reported annotations are honored: read-only tools run freely, everything else pauses for approval.
```

(Remove the `​` zero-width guards around the fences when writing the real file — they exist only to nest fences in this plan.)

- [ ] **Step 2: Repo-wide verification**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all green. Fix anything that isn't before proceeding.

- [ ] **Step 3: Commit**

```bash
git add docs/quickstart.md
git commit -m "docs: MCP servers quickstart section"
```

---

### Task 9: Live smoke verification (before PR)

No new files — this is the verification-before-completion gate.

- [ ] **Step 1: Run a real MCP server locally and exercise the full path**

Use the reference Everything server (has read-only AND destructive-ish tools) over Streamable HTTP:

```bash
npx -y @modelcontextprotocol/server-everything streamableHttp --port 3311
```

(Its HTTP endpoint is `http://localhost:3311/mcp`. If the CLI shape differs, check `npx @modelcontextprotocol/server-everything --help`.)

Then a scratch script (scratchpad, not committed) that builds `createMcpToolSource()`, fetches from `{ name: "everything", url: "http://localhost:3311/mcp" }`, and prints tool names + recovered annotations. Verify:
1. Tools list non-empty, names come back unprefixed from the source (prefixing happens in ingest).
2. `annotations` includes real hints (e.g. `echo` has `readOnlyHint` in recent versions — if the server version reports no annotations, verify the field is `{}` and note it).
3. A tool executes round-trip.

- [ ] **Step 2: End-to-end through a demo app**

Add the everything server to the Cadence or demo-bank app's handler config (`mcpServers: [...]` — local change, not committed), run `pnpm demo`, and in the chat ask the agent to call an MCP tool (e.g. "use the everything echo tool to echo 'hi'"). Verify:
1. The tool call appears and (annotation-dependent) either runs directly (readOnly) or pauses for approval.
2. Approving executes and the result reaches the model.
3. Console shows no collision/skip warnings.

Capture terminal/browser evidence for the PR body (this feature is not UI-affecting — no screenshots of new UI needed, but the chat transcript screenshot is good PR evidence).

- [ ] **Step 3: Open the PR**

Branch is `yousefh409/mcp-client-support`. Push and open a PR titled `feat: MCP client support — host-configured servers as policy-governed agent tools (spec 2026-07-04)`, body covering: spec link, the 8 scope rulings, the `listTools()` cast rationale + contract-test guard, live-smoke evidence. **Never merge — Yousef merges.**

---

## Self-review notes (completed)

- **Spec coverage:** ingestion module (T1/T2), engine wiring + precedence (T3), config surfaces + override + env substitution (T4-T7), capability flag (T6/T7), error handling table (T1 fault tolerance, T4 drop-on-missing, T3 cache-retry, existing onCollision/onSkip), testing section (unit T1, contract T2, handler T5-T7, live smoke T9), docs (T8). Deferred list needs no code.
- **Types:** `McpServerConfig`/`McpToolSource`/`McpFetchResult` defined in T1, consumed in T2/T3 (runtime) and T4-T7 (next, via `@flowlet/runtime` exports added in T3 Step 5 — note Tasks 4-7 need Task 3's export step done first).
- **Known judgment calls for the executor:** engine cache eviction rule (empty-with-servers → evict) is spelled out in T3; contract-test fake server details (notification = 200 no content-type, echo protocolVersion) are spelled out in T2.
