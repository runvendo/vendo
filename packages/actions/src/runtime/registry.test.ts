import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  descriptorHash,
  toolOutcomeSchema,
  type ActAs,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { Connector } from "../connectors/connector.js";
import type { ExtractedTool } from "../formats.js";
import { createActions, type ActionsRunContext } from "./registry.js";

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

  it("rejects invalid connector descriptor names with the descriptor source", async () => {
    const actions = createActions({
      connectors: [connector([{ name: "invalid.name", description: "Invalid", inputSchema: {}, risk: "read" }])],
    });
    await expect(actions.descriptors()).rejects.toMatchObject({
      name: "VendoError",
      code: "validation",
      message: expect.stringContaining("connector stub[0]"),
    });
  });

  it("validates configured host tools and added registry descriptors", async () => {
    await expect(createActions({ tools: [routeTool("invalid.host")] }).descriptors()).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("config.tools[0]"),
    });

    const actions = createActions({});
    actions.add({
      descriptors: async () => [{ name: "invalid.added", description: "Invalid", inputSchema: {}, risk: "read" }],
      execute: async () => ({ status: "ok", output: null }),
    });
    await expect(actions.descriptors()).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("added registry[0][0]"),
    });
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

  it("exposes a descriptorHash computed post-merge so an override lapses old grants", async () => {
    // 04 §1 merge rule: descriptorHash is computed over the MERGED descriptor.
    // An overrides.json risk bump must change the hash the runtime exposes, which is
    // exactly the drift that lapses a grant bound to the pre-override descriptor.
    const base = routeTool("host_invoices_delete", { risk: "write" });
    const root = await tempVendo(
      { format: VENDO_TOOLS_FORMAT, tools: [base] },
      { format: VENDO_OVERRIDES_FORMAT, tools: { host_invoices_delete: { risk: "destructive", critical: true } } },
    );
    const actions = createActions({ dir: root, baseUrl: "http://stub" });
    const [descriptor] = await actions.descriptors();
    expect(descriptor).toMatchObject({ name: "host_invoices_delete", risk: "destructive", critical: true });

    const merged: ToolDescriptor = {
      name: "host_invoices_delete",
      description: "host_invoices_delete",
      inputSchema: { type: "object" },
      risk: "destructive",
      critical: true,
    };
    const preMerge: ToolDescriptor = { name: "host_invoices_delete", description: "host_invoices_delete", inputSchema: { type: "object" }, risk: "write" };
    expect(descriptorHash(descriptor!)).toBe(descriptorHash(merged));
    expect(descriptorHash(descriptor!)).not.toBe(descriptorHash(preMerge));
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
  it("forwards present credentials only to the configured host origin", async () => {
    const firstHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const secondHeaders: Array<Record<string, string | string[] | undefined>> = [];
    async function stub(headers: Array<Record<string, string | string[] | undefined>>): Promise<string> {
      const server = createServer((req, res) => {
        headers.push(req.headers);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
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
      return `http://127.0.0.1:${port}`;
    }

    const configuredOrigin = await stub(firstHeaders);
    const otherOrigin = await stub(secondHeaders);
    const tools: ExtractedTool[] = [
      routeTool("host_same_origin", {
        binding: { kind: "openapi", operationId: "same", baseUrl: configuredOrigin, method: "GET", path: "/same" },
      }),
      routeTool("host_other_origin", {
        binding: { kind: "openapi", operationId: "other", baseUrl: otherOrigin, method: "GET", path: "/other" },
      }),
    ];
    const actions = createActions({ tools, baseUrl: configuredOrigin });
    const presentCtx: RunContext = {
      ...ctx,
      requestHeaders: { cookie: "fixture_session=user_1", authorization: "Bearer inbound" },
    };

    await expect(actions.execute({ id: "1", tool: "host_same_origin", args: {} }, presentCtx)).resolves.toMatchObject({ status: "ok" });
    await expect(actions.execute({ id: "2", tool: "host_other_origin", args: {} }, presentCtx)).resolves.toMatchObject({ status: "ok" });
    expect(firstHeaders[0]?.cookie).toBe("fixture_session=user_1");
    expect(firstHeaders[0]?.authorization).toBe("Bearer inbound");
    expect(secondHeaders[0]?.cookie).toBeUndefined();
    expect(secondHeaders[0]?.authorization).toBeUndefined();
    expect(secondHeaders[0]?.accept).toBe("application/json");
  });

  it("never forwards credentials to an untrusted (auto-learned) base origin", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const { port } = server.address() as AddressInfo;
    closers.push(async () => { server.close(); server.closeAllConnections(); });
    const learnedOrigin = `http://127.0.0.1:${port}`;
    // A relative route binding + an untrusted base (the umbrella's zero-config
    // same-origin default): the route still resolves, but the caller's cookie/
    // authorization MUST NOT be forwarded to a possibly-poisoned origin.
    const actions = createActions({
      tools: [routeTool("host_probe")],
      baseUrl: learnedOrigin,
      baseUrlTrusted: false,
    });
    const presentCtx: RunContext = {
      ...ctx,
      requestHeaders: { cookie: "fixture_session=user_1", authorization: "Bearer inbound" },
    };
    await expect(actions.execute({ id: "1", tool: "host_probe", args: {} }, presentCtx)).resolves.toMatchObject({ status: "ok" });
    expect(seen[0]?.cookie).toBeUndefined();
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[0]?.accept).toBe("application/json");
  });

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

  it("expands array path arguments as individually encoded catch-all segments", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
    const actions = createActions({
      tools: [routeTool("host_files", {
        binding: { kind: "route", method: "GET", path: "/files/{slug}", argsIn: "query" },
      })],
      baseUrl: "http://fixture.test",
      fetch: request as unknown as typeof fetch,
    });

    await expect(actions.execute(
      { id: "1", tool: "host_files", args: { slug: ["folder one", "child/name"] } },
      ctx,
    )).resolves.toMatchObject({ status: "ok" });
    expect((request.mock.calls[0]?.[0] as URL).pathname).toBe("/files/folder%20one/child%2Fname");
  });
});

describe("host HTTP execution — venue=mcp (10-mcp §3 / 04 §4 ActAs auth)", () => {
  async function hostServer(): Promise<{ url: string; seen: Array<Record<string, string | string[] | undefined>> }> {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const { port } = server.address() as AddressInfo;
    closers.push(async () => { server.close(); server.closeAllConnections(); });
    return { url: `http://127.0.0.1:${port}`, seen };
  }

  const writeTool = (baseUrl: string): ExtractedTool =>
    routeTool("host_write", {
      risk: "write",
      binding: { kind: "openapi", operationId: "write", baseUrl, method: "POST", path: "/write" },
    });

  const mcpCtx = (extra: Partial<ActionsRunContext>): ActionsRunContext => ({
    principal: { kind: "user", subject: "user_1" },
    venue: "mcp",
    presence: "present",
    sessionId: "mcps_1",
    ...extra,
  });

  it("never forwards ctx.requestHeaders; sends only the actAs AuthMaterial headers", async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer act-as-user_1" } }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    // A poisoned/forged ctx: the inbound MCP bearer and a cookie ride along.
    const ctx = mcpCtx({
      mcpConsent: { clientId: "mcpc_x", scopes: ["read", "write"] },
      requestHeaders: { cookie: "fixture_session=user_1", authorization: "Bearer inbound-mcp-bearer" },
    });

    await expect(actions.execute({ id: "1", tool: "host_write", args: {} }, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(host.seen[0]?.cookie).toBeUndefined();
    expect(host.seen[0]?.authorization).toBe("Bearer act-as-user_1");
  });

  it("returns not-implemented and makes no host request when actAs is absent", async () => {
    const host = await hostServer();
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url });
    const out = await actions.execute(
      { id: "1", tool: "host_write", args: {} },
      mcpCtx({ mcpConsent: { clientId: "mcpc_x", scopes: ["read"] } }),
    );
    expect(out).toMatchObject({ status: "error", error: { code: "not-implemented" } });
    if (out.status === "error") expect(out.error.message).toContain("actAs");
    expect(host.seen).toHaveLength(0);
  });

  it("returns an error and makes no host request when actAs declines (null)", async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => null);
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    const out = await actions.execute(
      { id: "1", tool: "host_write", args: {} },
      mcpCtx({ mcpConsent: { clientId: "mcpc_x", scopes: ["read"] } }),
    );
    expect(out).toMatchObject({ status: "error", error: { code: "not-implemented", message: "the host declined MCP execution for this action" } });
    expect(host.seen).toHaveLength(0);
  });

  it("hands actAs the consent projection when the guard attached no grant", async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer act" } }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    const ctx = mcpCtx({ sessionId: "mcps_42", mcpConsent: { clientId: "mcpc_x", scopes: ["read", "write"] } });

    await expect(actions.execute({ id: "1", tool: "host_write", args: {} }, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(actAs).toHaveBeenCalledTimes(1);
    const [principal, grant] = actAs.mock.calls[0] as unknown as [Principal, PermissionGrant];
    expect(principal).toEqual({ kind: "user", subject: "user_1" });
    expect(grant).toMatchObject({
      id: "grt_mcp_mcps_42",
      subject: "user_1",
      tool: "host_write",
      scope: { kind: "tool" },
      duration: "session",
      contextKey: "mcps_42",
      source: "mcp",
    });
    // descriptorHash is core's, computed over the merged descriptor.
    expect(grant.descriptorHash).toBe(
      descriptorHash({ name: "host_write", description: "host_write", inputSchema: { type: "object" }, risk: "write" }),
    );
  });

  it("hands actAs the guard-attached grant verbatim, not a projection", async () => {
    const host = await hostServer();
    const realGrant: PermissionGrant = {
      id: "grt_real",
      subject: "user_1",
      tool: "host_write",
      descriptorHash: "sha256:real",
      scope: { kind: "tool" },
      duration: "standing",
      source: "chat",
      grantedAt: "2026-07-13T00:00:00.000Z",
    };
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer act" } }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    // Both a real grant and a consent record are present: the real grant wins.
    const ctx = mcpCtx({ grant: realGrant, mcpConsent: { clientId: "mcpc_x", scopes: ["read"] } });

    await expect(actions.execute({ id: "1", tool: "host_write", args: {} }, ctx)).resolves.toMatchObject({ status: "ok" });
    const [, passed] = actAs.mock.calls[0] as unknown as [Principal, PermissionGrant];
    expect(passed).toBe(realGrant);
  });

  it("refuses a guard-attached grant for a different subject before actAs", async () => {
    const host = await hostServer();
    const mismatchedGrant: PermissionGrant = {
      id: "grt_other_user",
      subject: "user_2",
      tool: "host_write",
      descriptorHash: "sha256:real",
      scope: { kind: "tool" },
      duration: "standing",
      source: "chat",
      grantedAt: "2026-07-14T00:00:00.000Z",
    };
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer act" } }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });

    const outcome = await actions.execute(
      { id: "1", tool: "host_write", args: {} },
      mcpCtx({ grant: mismatchedGrant, mcpConsent: { clientId: "mcpc_x", scopes: ["write"] } }),
    );

    expect(outcome).toMatchObject({ status: "error", error: { code: "act-as-subject-mismatch" } });
    expect(actAs).not.toHaveBeenCalled();
    expect(host.seen).toHaveLength(0);
  });

  it("fails closed when the ctx carries neither a grant nor mcpConsent", async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => ({ headers: {} }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    const out = await actions.execute({ id: "1", tool: "host_write", args: {} }, mcpCtx({}));
    expect(out).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(actAs).not.toHaveBeenCalled();
    expect(host.seen).toHaveLength(0);
  });

  // FIX A: apps re-contextualizes a door-driven in-app tool ref to
  // `{ ...ctx, venue: "app", appId }` (06-apps call.ts), so it reaches executeHost
  // as venue="app" — but the door's mcpConsent survives that spread and is the
  // key that routes to actAs.
  it("routes a venue=app ctx carrying the door's mcpConsent through actAs, forwarding nothing", async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer act-as-user_1" } }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    const ctx = mcpCtx({
      venue: "app",
      appId: "app_1",
      mcpConsent: { clientId: "mcpc_x", scopes: ["read", "write"] },
      requestHeaders: { cookie: "fixture_session=user_1", authorization: "Bearer inbound-mcp-bearer" },
    });

    await expect(actions.execute({ id: "1", tool: "host_write", args: {} }, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(actAs).toHaveBeenCalledTimes(1);
    const [, grant] = actAs.mock.calls[0] as unknown as [Principal, PermissionGrant];
    expect(grant).toMatchObject({ source: "mcp", scope: { kind: "tool" } });
    // No forwarded browser session — only the actAs AuthMaterial reaches the host.
    expect(host.seen[0]?.cookie).toBeUndefined();
    expect(host.seen[0]?.authorization).toBe("Bearer act-as-user_1");
  });

  it("leaves a venue=app ctx WITHOUT mcpConsent on the ordinary present-forward path (unchanged)", async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer act" } }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    const ctx = mcpCtx({ venue: "app", appId: "app_1", requestHeaders: { cookie: "fixture_session=user_1" } });

    await expect(actions.execute({ id: "1", tool: "host_write", args: {} }, ctx)).resolves.toMatchObject({ status: "ok" });
    // Ordinary in-product app use: actAs is not consulted and the present cookie
    // forwards to the trusted host origin exactly as before.
    expect(actAs).not.toHaveBeenCalled();
    expect(host.seen[0]?.cookie).toBe("fixture_session=user_1");
  });
});
