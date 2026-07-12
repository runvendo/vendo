import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  toolOutcomeSchema,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { Connector } from "../connectors/connector.js";
import type { ExtractedTool } from "../formats.js";
import { createActions } from "./registry.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_1" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function routeTool(name: string, extras: Partial<ExtractedTool> = {}): ExtractedTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/probe", argsIn: "query" },
    ...extras,
  };
}

function connector(descriptors: ToolDescriptor[], execute?: Connector["execute"]): Connector {
  return {
    name: "stub",
    descriptors: async () => descriptors,
    execute: execute ?? (async (call) => ({ status: "ok", output: { connector: call.tool } })),
  };
}

async function tempVendo(tools: unknown, overrides?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-actions-"));
  roots.push(root);
  await mkdir(join(root, ".vendo"));
  await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify(tools));
  if (overrides !== undefined) {
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify(overrides));
  }
  return root;
}

describe("createActions registry", () => {
  it("loads lazily once, applies overrides to host and connector tools, and hides disabled names", async () => {
    const host = routeTool("host_probe");
    const root = await tempVendo(
      { format: VENDO_TOOLS_FORMAT, tools: [host, routeTool("host_hidden")] },
      {
        format: VENDO_OVERRIDES_FORMAT,
        tools: {
          host_probe: { risk: "destructive", critical: true, description: "Overridden host" },
          host_hidden: { disabled: true },
          ext_write: { risk: "read", description: "Overridden connector" },
          ext_hidden: { disabled: true },
        },
      },
    );
    const descriptorSpy = vi.fn(async () => [
      { name: "ext_write", description: "Write", inputSchema: {}, risk: "write" as const },
      { name: "ext_hidden", description: "Hidden", inputSchema: {}, risk: "write" as const },
    ]);
    const ext: Connector = { name: "ext", descriptors: descriptorSpy, execute: async () => ({ status: "ok", output: true }) };
    const actions = createActions({ dir: root, connectors: [ext], fetch: vi.fn() as unknown as typeof fetch, baseUrl: "http://stub" });

    await expect(actions.descriptors()).resolves.toEqual([
      { name: "host_probe", description: "Overridden host", inputSchema: { type: "object" }, risk: "destructive", critical: true },
      { name: "ext_write", description: "Overridden connector", inputSchema: {}, risk: "read" },
    ]);
    await actions.descriptors();
    expect(descriptorSpy).toHaveBeenCalledTimes(1);
    await expect(actions.execute({ id: "1", tool: "host_hidden", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
    await expect(actions.execute({ id: "2", tool: "ext_hidden", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
  });

  it("throws validation errors for malformed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-actions-bad-"));
    roots.push(root);
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "tools.json"), "{ definitely-not-json");
    const actions = createActions({ dir: root });
    await expect(actions.descriptors()).rejects.toMatchObject({ name: "VendoError", code: "validation" });
  });

  it("reserves disabled names and throws conflicts across every source", async () => {
    const actions = createActions({
      tools: [routeTool("same", { disabled: true })],
      connectors: [connector([{ name: "same", description: "Same", inputSchema: {}, risk: "read" }])],
    });
    await expect(actions.descriptors()).rejects.toEqual(expect.objectContaining({ code: "conflict" }));
  });

  it("propagates connector descriptor failures instead of shrinking the surface", async () => {
    const failure = new Error("connector unavailable");
    const actions = createActions({
      connectors: [{ name: "broken", descriptors: async () => Promise.reject(failure), execute: async () => ({ status: "ok", output: null }) }],
    });
    await expect(actions.descriptors()).rejects.toBe(failure);
  });

  it("dispatches added registries untouched and catches connector execute rejections", async () => {
    const addedOutcome: ToolOutcome = { status: "blocked", reason: "owned by child" };
    const added: ToolRegistry = {
      descriptors: async () => [{ name: "vendo_apps_create", description: "Create app", inputSchema: {}, risk: "write" }],
      execute: vi.fn(async () => addedOutcome),
    };
    const ext = connector(
      [{ name: "ext_fail", description: "Fail", inputSchema: {}, risk: "write" }],
      async () => Promise.reject(new Error("provider down")),
    );
    const actions = createActions({ connectors: [ext] });
    actions.add(added);

    expect((await actions.descriptors()).map((item) => item.name)).toEqual(["ext_fail", "vendo_apps_create"]);
    await expect(actions.execute({ id: "1", tool: "vendo_apps_create", args: {} }, ctx)).resolves.toBe(addedOutcome);
    const failed = await actions.execute({ id: "2", tool: "ext_fail", args: {} }, ctx);
    expect(toolOutcomeSchema.parse(failed)).toMatchObject({
      status: "error",
      error: { code: "connector-error", message: "provider down" },
    });
  });

  it("supports add after the first lazy load without re-describing cached sources", async () => {
    const descriptorSpy = vi.fn(async () => [{ name: "ext_one", description: "One", inputSchema: {}, risk: "read" as const }]);
    const actions = createActions({ connectors: [{ name: "ext", descriptors: descriptorSpy, execute: async () => ({ status: "ok", output: null }) }] });
    await actions.descriptors();
    actions.add({
      descriptors: async () => [{ name: "added", description: "Added", inputSchema: {}, risk: "read" }],
      execute: async () => ({ status: "ok", output: "added" }),
    });
    expect((await actions.descriptors()).map((item) => item.name)).toEqual(["ext_one", "added"]);
    expect(descriptorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("host HTTP execution", () => {
  it("encodes query values, strips unsafe forwarded headers, and maps JSON/non-JSON/HTTP failures", async () => {
    const requests: Array<{ url: URL; headers: Record<string, string> }> = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      requests.push({ url, headers: req.headers as Record<string, string> });
      if (url.searchParams.get("mode") === "text") {
        res.setHeader("content-type", "text/plain");
        res.end("plain response");
      } else if (url.searchParams.get("mode") === "fail") {
        res.statusCode = 503;
        res.end("x".repeat(250));
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ values: url.searchParams.getAll("tag"), filter: url.searchParams.get("filter") }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    closers.push(async () => {
      server.close();
      server.closeAllConnections();
    });
    const actions = createActions({ tools: [routeTool("host_probe")], baseUrl: `http://127.0.0.1:${port}` });

    const presentCtx: RunContext = {
      ...ctx,
      requestHeaders: {
        cookie: "fixture_session=user_1",
        authorization: "Bearer inbound",
        host: "malicious.test",
        connection: "close",
        "content-length": "999",
      },
    };
    const ok = await actions.execute(
      { id: "1", tool: "host_probe", args: { tag: ["a", "b"], filter: { active: true } } },
      presentCtx,
    );
    expect(toolOutcomeSchema.parse(ok)).toEqual({
      status: "ok",
      output: { values: ["a", "b"], filter: '{"active":true}' },
    });
    expect(requests[0]?.headers.cookie).toBe("fixture_session=user_1");
    expect(requests[0]?.headers.authorization).toBe("Bearer inbound");
    expect(requests[0]?.headers.host).toBe(`127.0.0.1:${port}`);
    expect(requests[0]?.headers.connection).not.toBe("close");
    expect(requests[0]?.headers["content-length"]).toBeUndefined();

    const text = await actions.execute({ id: "2", tool: "host_probe", args: { mode: "text" } }, ctx);
    expect(toolOutcomeSchema.parse(text)).toEqual({ status: "ok", output: { status: 200, text: "plain response" } });
    const failed = await actions.execute({ id: "3", tool: "host_probe", args: { mode: "fail" } }, ctx);
    expect(toolOutcomeSchema.parse(failed)).toMatchObject({ status: "error", error: { code: "http-error" } });
    if (failed.status === "error") {
      expect(failed.error.message).toContain("GET /probe → 503:");
      expect(failed.error.message).toHaveLength("GET /probe → 503: ".length + 200);
    }
  });

  it("returns validation and network outcomes instead of throwing per-call failures", async () => {
    const missingBase = createActions({ tools: [routeTool("host_by_id", { binding: { kind: "route", method: "GET", path: "/probe/{id}", argsIn: "query" } })] });
    await expect(missingBase.execute({ id: "1", tool: "host_by_id", args: { id: "x" } }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation", message: expect.stringContaining("baseUrl") },
    });
    await expect(missingBase.execute({ id: "2", tool: "host_by_id", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation", message: expect.stringContaining("id") },
    });
    await expect(missingBase.execute({ id: "3", tool: "host_by_id", args: [] }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });

    const network = createActions({
      tools: [routeTool("host_network")],
      baseUrl: "http://unused.test",
      fetch: async () => Promise.reject(new Error("socket closed")),
    });
    await expect(network.execute({ id: "4", tool: "host_network", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "network-error", message: "socket closed" },
    });
  });
});
