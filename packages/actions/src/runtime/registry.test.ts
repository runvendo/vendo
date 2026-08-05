import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spies on the ONE seam the registry's disk reads flow through
// (readOptionalVendoJson → node:fs/promises's readFile). Defaults to the
// real implementation for every existing test in this file; the
// "in-memory profile skips the disk leg" describe block below is the only
// place that asserts call counts or overrides the implementation.
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  readFileMock.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileMock };
});
import {
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
import {
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  type ExtractedTool,
} from "../formats.js";
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
          host_probe: { risk: "destructive", confirmEach: true, description: "Overridden host" },
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
      { name: "host_probe", description: "Overridden host", inputSchema: { type: "object" }, risk: "destructive", confirmEach: true },
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

  // D5 (2026-08-03): extraction records the host's declared response body, and
  // the descriptor whitelist used to drop it — so the model learned a query's
  // fields only by calling it once. Carried verbatim now, still never invented.
  it("carries an extracted outputSchema onto the descriptor, and omits it when there is none", async () => {
    const outputSchema = { type: "object", properties: { data: { type: "array" } }, required: ["data"] };
    const root = await tempVendo({
      format: VENDO_TOOLS_FORMAT,
      tools: [routeTool("host_declared", { outputSchema }), routeTool("host_undeclared")],
    });
    const actions = createActions({ dir: root, fetch: vi.fn() as unknown as typeof fetch, baseUrl: "http://stub" });

    const [declared, undeclared] = await actions.descriptors();
    expect(declared?.outputSchema).toEqual(outputSchema);
    expect(undeclared).not.toHaveProperty("outputSchema");
  });

  describe("hosted-config overrides injection (cse lane 3)", () => {
    const toolsV3 = { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_a"), routeTool("host_b")] };
    const disable = (name: string) => ({ format: VENDO_OVERRIDES_FORMAT, tools: { [name]: { disabled: true } } });
    const liveNames = async (actions: ReturnType<typeof createActions>): Promise<string[]> =>
      (await actions.descriptors()).map((d) => d.name).sort();

    it("(a) unset — no injection reads .vendo/overrides.json exactly as today", async () => {
      const root = await tempVendo(toolsV3, disable("host_b"));
      const actions = createActions({ dir: root });
      expect(await liveNames(actions)).toEqual(["host_a"]);
    });

    it("(b) injected overrides win over the overrides.json file read", async () => {
      // The file would hide host_a; the injected doc hides host_b instead. The
      // umbrella only injects when there is no local file, so at the block level
      // the injection simply takes precedence and the file is not read.
      const root = await tempVendo(toolsV3, disable("host_a"));
      const actions = createActions({ dir: root, overrides: disable("host_b") });
      expect(await liveNames(actions)).toEqual(["host_a"]);
    });

    it("(c) injected overrides apply when there is no local file (cloud-owned surface)", async () => {
      const root = await tempVendo(toolsV3); // no overrides.json on disk
      const actions = createActions({ dir: root, overrides: disable("host_b") });
      expect(await liveNames(actions)).toEqual(["host_a"]);
    });

    it("accepts an async provider resolved once through the memoized loadHost", async () => {
      const root = await tempVendo(toolsV3);
      // Async provider — the umbrella awaits a first-request cloud fetch here.
      const provider = vi.fn(async () => disable("host_b"));
      const actions = createActions({ dir: root, overrides: provider });
      expect(await liveNames(actions)).toEqual(["host_a"]);
      await actions.descriptors(); // second call must reuse the memoized host
      expect(provider).toHaveBeenCalledTimes(1);
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
      descriptors: async () => [{ name: "vendo_make", description: "Make a screen", inputSchema: {}, risk: "read" }],
      execute: vi.fn(async () => addedOutcome),
    };
    const ext = connector(
      [{ name: "ext_fail", description: "Fail", inputSchema: {}, risk: "write" }],
      async () => Promise.reject(new Error("provider down")),
    );
    const actions = createActions({ connectors: [ext] });
    actions.add(added);

    expect((await actions.descriptors()).map((item) => item.name)).toEqual(["ext_fail", "vendo_make"]);
    await expect(actions.execute({ id: "1", tool: "vendo_make", args: {} }, ctx)).resolves.toBe(addedOutcome);
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
      { format: VENDO_OVERRIDES_FORMAT, tools: { host_invoices_delete: { risk: "destructive", confirmEach: true } } },
    );
    const actions = createActions({ dir: root, baseUrl: "http://stub" });
    const [descriptor] = await actions.descriptors();
    expect(descriptor).toMatchObject({ name: "host_invoices_delete", risk: "destructive", confirmEach: true });

    const merged: ToolDescriptor = {
      name: "host_invoices_delete",
      description: "host_invoices_delete",
      inputSchema: { type: "object" },
      risk: "destructive",
      confirmEach: true,
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

  it("09-vendo §2 (install-dx wave 1.1): fails a present-mode call closed on an untrusted origin when untrustedOriginPolicy is 'fail', instead of running it unauthenticated", async () => {
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
    const warned: Array<{ reason: string }> = [];
    const actions = createActions({
      tools: [routeTool("host_probe")],
      baseUrl: learnedOrigin,
      baseUrlTrusted: false,
      untrustedOriginPolicy: "fail",
      onPresentCredentialsNotForwarded: async (event) => { warned.push({ reason: event.reason }); },
    });
    const presentCtx: RunContext = {
      ...ctx,
      requestHeaders: { cookie: "fixture_session=user_1", authorization: "Bearer inbound" },
    };
    const outcome = await actions.execute({ id: "1", tool: "host_probe", args: {} }, presentCtx);
    expect(outcome).toMatchObject({
      status: "error",
      error: { code: "blocked", message: expect.stringContaining("VENDO_BASE_URL") },
    });
    // The host never sees the call — "fail" refuses BEFORE the outbound fetch,
    // it does not merely audit a call that ran unauthenticated.
    expect(seen).toHaveLength(0);
    // The audit warning still records (the umbrella reports it before failing).
    expect(warned).toEqual([{ reason: "untrusted-host-origin" }]);
  });

  it("09-vendo §2 (install-dx wave 1.1): 'cross-origin-binding' never fails even under untrustedOriginPolicy: 'fail' — same-origin trust must never extend cross-origin", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    async function stub(): Promise<string> {
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
      return `http://127.0.0.1:${port}`;
    }
    const configuredOrigin = await stub();
    const otherOrigin = await stub();
    const warned: Array<{ reason: string }> = [];
    const actions = createActions({
      tools: [routeTool("host_other_origin", {
        binding: { kind: "openapi", operationId: "other", baseUrl: otherOrigin, method: "GET", path: "/other" },
      })],
      baseUrl: configuredOrigin,
      untrustedOriginPolicy: "fail",
      onPresentCredentialsNotForwarded: async (event) => { warned.push({ reason: event.reason }); },
    });
    const presentCtx: RunContext = {
      ...ctx,
      requestHeaders: { cookie: "fixture_session=user_1", authorization: "Bearer inbound" },
    };
    // The call still runs (unauthenticated to the other origin) — a refused
    // cross-origin binding is a routing fact, not a missing-VENDO_BASE_URL fact.
    await expect(actions.execute({ id: "1", tool: "host_other_origin", args: {} }, presentCtx))
      .resolves.toMatchObject({ status: "ok" });
    expect(warned).toEqual([{ reason: "cross-origin-binding" }]);
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
      const prefix = `GET http://127.0.0.1:${port}/probe → 503: `;
      expect(failed.error.message).toContain(prefix);
      expect(failed.error.message).toHaveLength(prefix.length + 200);
    }
  });

  // A wrong wire origin 404s every tool call while every path is correct, so an
  // http failure that carries only the path reads exactly like a wrong path.
  it("names the origin in an http failure without leaking the URL's credentials", async () => {
    const actions = createActions({
      tools: [routeTool("host_probe")],
      baseUrl: "https://svc:s3cret-password@wrong-host.test:8443",
      fetch: async () => new Response("no such route", { status: 404 }),
    });
    const failed = await actions.execute(
      { id: "1", tool: "host_probe", args: { access_token: "sk-live-querytoken" } },
      ctx,
    );
    expect(failed).toMatchObject({ status: "error", error: { code: "http-error" } });
    if (failed.status !== "error") return;
    expect(failed.error.message).toBe("GET https://wrong-host.test:8443/probe → 404: no such route");
    expect(failed.error.message).not.toContain("s3cret-password");
    expect(failed.error.message).not.toContain("svc");
    expect(failed.error.message).not.toContain("sk-live-querytoken");
  });

  it("keeps token-only userinfo out of an http failure", async () => {
    const actions = createActions({
      tools: [routeTool("host_probe")],
      baseUrl: "https://ghp_tokenonlyuserinfo@wrong-host.test",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    const failed = await actions.execute({ id: "1", tool: "host_probe", args: {} }, ctx);
    expect(failed).toMatchObject({ status: "error", error: { code: "http-error" } });
    if (failed.status !== "error") return;
    expect(failed.error.message).toBe("GET https://wrong-host.test/probe → 500: nope");
    expect(failed.error.message).not.toContain("ghp_");
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

describe("host HTTP execution — away (ENG-263 away re-verification rides actAs)", () => {
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

  const awayGrant: PermissionGrant = {
    id: "grt_away",
    subject: "user_1",
    tool: "host_write",
    descriptorHash: "sha256:away",
    scope: { kind: "tool" },
    duration: "standing",
    source: "automation",
    grantedAt: "2026-07-14T00:00:00.000Z",
  };

  const awayCtx = (extra: Partial<ActionsRunContext> = {}): ActionsRunContext => ({
    principal: { kind: "user", subject: "user_1" },
    venue: "automation",
    presence: "away",
    sessionId: "sess_away_1",
    grant: awayGrant,
    ...extra,
  });

  it("fails the run closed when the host declines to mint (actAs returns null) — no host request, actAs:'declined'", async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => null);
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });

    const outcome = await actions.execute({ id: "1", tool: "host_write", args: {} }, awayCtx());

    expect(outcome).toMatchObject({
      status: "error",
      error: { code: "not-implemented", message: "the host declined away execution for this action" },
    });
    // The decline IS the re-verification: nothing reaches the host API.
    expect(host.seen).toHaveLength(0);
    // Audit enrichment passthrough for the guard binding to lift.
    expect((outcome as { actAs?: string }).actAs).toBe("declined");
  });

  it("tags successful away execution with actAs:'minted' and sends only AuthMaterial headers", async () => {
    const host = await hostServer();
    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer away-user_1" } }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    // A poisoned away ctx should forward nothing of its own.
    const ctx = awayCtx({ requestHeaders: { cookie: "stolen=1", authorization: "Bearer inbound" } });

    const outcome = await actions.execute({ id: "1", tool: "host_write", args: {} }, ctx);

    expect(outcome).toMatchObject({ status: "ok" });
    expect((outcome as { actAs?: string }).actAs).toBe("minted");
    expect(host.seen[0]?.authorization).toBe("Bearer away-user_1");
    expect(host.seen[0]?.cookie).toBeUndefined();
  });

  it("tags an actAs throw with actAs:'error' and a cross-subject grant with actAs:'mismatch'", async () => {
    const host = await hostServer();
    const throwing = createActions({
      tools: [writeTool(host.url)],
      baseUrl: host.url,
      actAs: async () => { throw new Error("mint exploded"); },
    });
    const thrown = await throwing.execute({ id: "1", tool: "host_write", args: {} }, awayCtx());
    expect(thrown).toMatchObject({ status: "error", error: { code: "act-as-error" } });
    expect((thrown as { actAs?: string }).actAs).toBe("error");

    const actAs = vi.fn(async () => ({ headers: { authorization: "Bearer x" } }));
    const actions = createActions({ tools: [writeTool(host.url)], baseUrl: host.url, actAs });
    const mismatch = await actions.execute(
      { id: "2", tool: "host_write", args: {} },
      awayCtx({ grant: { ...awayGrant, subject: "user_2" } }),
    );
    expect(mismatch).toMatchObject({ status: "error", error: { code: "act-as-subject-mismatch" } });
    expect((mismatch as { actAs?: string }).actAs).toBe("mismatch");
    expect(actAs).not.toHaveBeenCalled();
    expect(host.seen).toHaveLength(0);
  });
});

describe("host HTTP execution — trpc bindings (04 §1 tRPC HTTP envelope)", () => {
  const trpcTool = (extras: Partial<ExtractedTool["binding"] & Record<string, unknown>> = {}): ExtractedTool => ({
    name: "host_polls_list",
    description: "tRPC query polls.list",
    inputSchema: { type: "object", properties: {} },
    risk: "read",
    binding: { kind: "trpc", procedure: "polls.list", type: "query", mount: "/api/trpc", ...extras },
  });

  function capturingFetch(status: number, payload: unknown): { fetch: typeof fetch; seen: Array<{ url: string; method?: string; body?: unknown }> } {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { fetch: impl, seen };
  }

  it("executes a query as GET {mount}/{procedure} with a plain-JSON input param", async () => {
    const { fetch, seen } = capturingFetch(200, { result: { data: [{ id: "p1" }] } });
    const actions = createActions({ tools: [trpcTool()], baseUrl: "http://host.test", fetch });

    const outcome = await actions.execute({ id: "1", tool: "host_polls_list", args: { status: "open" } }, ctx);
    expect(outcome).toEqual({ status: "ok", output: [{ id: "p1" }] });
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/api/trpc/polls.list");
    expect(seen[0]!.method).toBe("GET");
    expect(JSON.parse(url.searchParams.get("input")!)).toEqual({ status: "open" });
  });

  it("omits the input param when a query has no args", async () => {
    const { fetch, seen } = capturingFetch(200, { result: { data: "ok" } });
    const actions = createActions({ tools: [trpcTool()], baseUrl: "http://host.test", fetch });

    await actions.execute({ id: "1", tool: "host_polls_list", args: {} }, ctx);
    expect(new URL(seen[0]!.url).searchParams.get("input")).toBeNull();
  });

  it("wraps input and unwraps output through the superjson envelope", async () => {
    const { fetch, seen } = capturingFetch(200, { result: { data: { json: { created: true } } } });
    const tool: ExtractedTool = {
      name: "host_polls_create",
      description: "tRPC mutation polls.create",
      inputSchema: { type: "object" },
      risk: "write",
      binding: { kind: "trpc", procedure: "polls.create", type: "mutation", mount: "/api/trpc", transformer: "superjson" },
    };
    const actions = createActions({ tools: [tool], baseUrl: "http://host.test", fetch });

    const outcome = await actions.execute({ id: "1", tool: "host_polls_create", args: { title: "Standup" } }, ctx);
    expect(outcome).toEqual({ status: "ok", output: { created: true } });
    expect(seen[0]!.method).toBe("POST");
    expect(new URL(seen[0]!.url).pathname).toBe("/api/trpc/polls.create");
    expect(seen[0]!.body).toEqual({ json: { title: "Standup" } });
  });

  it("returns a validation outcome when no baseUrl is configured", async () => {
    const actions = createActions({ tools: [trpcTool()] });
    await expect(actions.execute({ id: "1", tool: "host_polls_list", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation", message: expect.stringContaining("baseUrl") },
    });
  });

  it("maps trpc error statuses to http-error outcomes", async () => {
    const { fetch } = capturingFetch(400, { error: { message: "BAD_REQUEST" } });
    const actions = createActions({ tools: [trpcTool()], baseUrl: "http://host.test", fetch });
    await expect(actions.execute({ id: "1", tool: "host_polls_list", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "http-error", message: expect.stringContaining("400") },
    });
  });
});

describe("host HTTP execution — graphql bindings (04 §1 GraphQL transport)", () => {
  const document = "query pollGet($id: ID!) { pollGet(id: $id) { id title } }";
  const graphqlTool = (extras: Partial<ExtractedTool["binding"] & Record<string, unknown>> = {}): ExtractedTool => ({
    name: "host_poll_get",
    description: "GraphQL query pollGet",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    risk: "read",
    binding: { kind: "graphql", operation: "pollGet", type: "query", endpoint: "/api/graphql", document, ...extras },
  });

  function capturingFetch(status: number, payload: unknown): { fetch: typeof fetch; seen: Array<{ url: string; method?: string; body?: unknown }> } {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { fetch: impl, seen };
  }

  it("executes as POST {endpoint} with the document and args as variables, unwrapping the root field", async () => {
    const { fetch, seen } = capturingFetch(200, { data: { pollGet: { id: "p1", title: "Standup" } } });
    const actions = createActions({ tools: [graphqlTool()], baseUrl: "http://host.test", fetch });

    const outcome = await actions.execute({ id: "1", tool: "host_poll_get", args: { id: "p1" } }, ctx);
    expect(outcome).toEqual({ status: "ok", output: { id: "p1", title: "Standup" } });
    expect(new URL(seen[0]!.url).pathname).toBe("/api/graphql");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toEqual({ query: document, variables: { id: "p1" } });
  });

  it("surfaces a 200-with-errors GraphQL response as an http-error outcome", async () => {
    const { fetch } = capturingFetch(200, { data: null, errors: [{ message: "Poll not found" }] });
    const actions = createActions({ tools: [graphqlTool()], baseUrl: "http://host.test", fetch });
    await expect(actions.execute({ id: "1", tool: "host_poll_get", args: { id: "p1" } }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "http-error", message: expect.stringContaining("Poll not found") },
    });
  });

  it("returns a validation outcome when no baseUrl is configured", async () => {
    const actions = createActions({ tools: [graphqlTool()] });
    await expect(actions.execute({ id: "1", tool: "host_poll_get", args: { id: "p1" } }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation", message: expect.stringContaining("baseUrl") },
    });
  });

  it("fails closed with a validation outcome when the binding carries no executable document", async () => {
    const actions = createActions({ tools: [graphqlTool({ document: undefined })], baseUrl: "http://host.test" });
    await expect(actions.execute({ id: "1", tool: "host_poll_get", args: { id: "p1" } }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation", message: expect.stringContaining("no executable document") },
    });
  });

  it("maps non-2xx graphql responses to http-error outcomes", async () => {
    const { fetch } = capturingFetch(500, { errors: [{ message: "boom" }] });
    const actions = createActions({ tools: [graphqlTool()], baseUrl: "http://host.test", fetch });
    await expect(actions.execute({ id: "1", tool: "host_poll_get", args: { id: "p1" } }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "http-error", message: expect.stringContaining("500") },
    });
  });
});

describe("zero-live-host-tools boot warning", () => {
  it("warns once when the composed host surface has no live tool", async () => {
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message: unknown) => { warned.push(String(message)); });
    try {
      const actions = createActions({ tools: [] });
      await actions.descriptors();
      await actions.descriptors();
      const hits = warned.filter((line) => line.includes("zero live host tools"));
      expect(hits).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("stays quiet when a live host tool exists", async () => {
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message: unknown) => { warned.push(String(message)); });
    try {
      const actions = createActions({ tools: [{
        name: "host_ping", description: "d", inputSchema: { type: "object" }, risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/ping", argsIn: "query" },
      }] });
      await actions.descriptors();
      expect(warned.filter((line) => line.includes("zero live host tools"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("in-memory overrides (unified try surface Task 15a, rebased on the v3 injection seam)", () => {
  it("applies config.overrides to in-memory tools exactly like a dir read's overrides.json", async () => {
    const actions = createActions({
      tools: [routeTool("host_probe"), routeTool("host_hidden")],
      overrides: {
        format: VENDO_OVERRIDES_FORMAT,
        tools: {
          host_probe: { risk: "destructive", confirmEach: true, description: "Overridden host" },
          host_hidden: { disabled: true },
        },
      },
    });

    await expect(actions.descriptors()).resolves.toEqual([
      { name: "host_probe", description: "Overridden host", inputSchema: { type: "object" }, risk: "destructive", confirmEach: true },
    ]);
    await expect(actions.execute({ id: "1", tool: "host_hidden", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
  });

  it("config.overrides wins over the dir's overrides.json (in-memory precedence, whole-file)", async () => {
    const root = await tempVendo(
      { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_probe")] },
      { format: VENDO_OVERRIDES_FORMAT, tools: { host_probe: { disabled: true } } },
    );
    const actions = createActions({
      dir: root,
      overrides: { format: VENDO_OVERRIDES_FORMAT, tools: { host_probe: { description: "kept live" } } },
    });

    // The disk file's disable never applies: the in-memory file replaces it whole.
    const descriptors = await actions.descriptors();
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual(["host_probe"]);
    expect(descriptors[0]!.description).toBe("kept live");
  });

  it("rejects a malformed config.overrides loudly (same posture as every authored file)", async () => {
    const actions = createActions({
      tools: [routeTool("host_probe")],
      overrides: { format: "not-overrides", tools: {} } as never,
    });
    await expect(actions.descriptors()).rejects.toMatchObject({ name: "VendoError", code: "validation" });
  });

  it("carries injected compounds and briefs (v3: they live in overrides.json)", async () => {
    const actions = createActions({
      tools: [routeTool("host_probe")],
      overrides: {
        format: VENDO_OVERRIDES_FORMAT,
        tools: {},
        compounds: [{
          name: "host_probe_flow",
          description: "host_probe_flow flow",
          inputSchema: { type: "object" },
          risk: "read",
          binding: { kind: "compound", steps: [{ id: "a", tool: "host_probe" }] },
        }],
        briefs: [{ name: "probe", text: "call host_probe first", tools: ["host_probe"] }],
      },
    });
    await expect(actions.descriptors()).resolves.toEqual([
      { name: "host_probe", description: "host_probe", inputSchema: { type: "object" }, risk: "read" },
      { name: "host_probe_flow", description: "host_probe_flow flow", inputSchema: { type: "object" }, risk: "read" },
    ]);
    await expect(actions.briefs()).resolves.toEqual([{ name: "probe", text: "call host_probe first", tools: ["host_probe"] }]);
  });
});

describe("in-memory profile pieces skip the disk leg entirely (workerd portability)", () => {
  // On workerd, an fs read that unenv doesn't implement throws a CODE-LESS
  // error, unlike Node's ENOENT (see host-files.test.ts and host-files.ts's
  // narrowed catch: ENOENT + code-less degrade, every other real fs error
  // code still throws — fail-closed for overrides.json in particular). The
  // primary fix here is that a supplied in-memory piece must make loadHost
  // skip its disk leg entirely — proven by a zero-call assertion, not just
  // by the composed result (the composed result alone can't tell "skipped"
  // from "read and discarded").
  beforeEach(() => {
    // The shared mock records every read across the whole file (every other
    // describe block's tests hit real disk); clear its call log before each
    // test here so the zero-calls assertions below only see THIS test's
    // reads.
    readFileMock.mockClear();
  });

  afterEach(async () => {
    // Restore the shared mock's default (delegate to the real fs) — the
    // last test below installs a path-conditional override.
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    readFileMock.mockReset();
    readFileMock.mockImplementation(actual.readFile);
  });

  it("config.tools skips the tools.json read — the dir's own (different) tools.json is never even opened", async () => {
    const root = await tempVendo({ format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_from_disk")] });
    const actions = createActions({ dir: root, tools: [routeTool("host_in_memory")] });

    const names = (await actions.descriptors()).map((d) => d.name);
    expect(names).toEqual(["host_in_memory"]);
    expect(readFileMock.mock.calls.some(([path]) => String(path).endsWith("tools.json"))).toBe(false);
  });

  it("config.overrides skips the overrides.json read — the dir's own file is never even opened", async () => {
    const root = await tempVendo(
      { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_probe")] },
      {
        format: VENDO_OVERRIDES_FORMAT,
        tools: {},
        compounds: [{
          name: "disk_compound",
          description: "disk_compound flow",
          inputSchema: { type: "object" },
          risk: "read",
          binding: { kind: "compound", steps: [{ id: "a", tool: "host_probe" }] },
        }],
      },
    );
    const actions = createActions({
      dir: root,
      overrides: { format: VENDO_OVERRIDES_FORMAT, tools: {} },
    });

    const names = (await actions.descriptors()).map((d) => d.name);
    expect(names).not.toContain("disk_compound");
    expect(readFileMock.mock.calls.some(([path]) => String(path).endsWith("overrides.json"))).toBe(false);
  });

  it("a residual overrides.json read that fails with a CODE-LESS error (workerd unenv class) degrades to absent instead of killing the composition", async () => {
    // config.tools IS supplied (its own disk leg is skipped above), but
    // config.overrides is NOT — this is the residual read that still has to
    // run, and it must survive a code-less failure the way ENOENT already
    // does (host-files.ts's narrowed catch — the other half of the fix).
    const root = await tempVendo({ format: VENDO_TOOLS_FORMAT, tools: [] });
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({ format: VENDO_OVERRIDES_FORMAT, tools: {} }));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    readFileMock.mockImplementation(async (path: unknown, ...rest: unknown[]) => {
      if (String(path).endsWith("overrides.json")) {
        throw Object.assign(new Error("not implemented"), { code: undefined });
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    });

    const actions = createActions({ dir: root, tools: [routeTool("host_in_memory")] });
    await expect(actions.descriptors()).resolves.toEqual([
      { name: "host_in_memory", description: "host_in_memory", inputSchema: { type: "object" }, risk: "read" },
    ]);
  });

  it("a residual overrides.json read that fails with a REAL fs error code (EACCES) still THROWS — fail closed, not open", async () => {
    // Same shape as the test above, but the failure carries a real fs error
    // code (a present-but-unreadable file on a real filesystem — e.g. a
    // volume-mount permission mismatch). overrides.json absent is MORE
    // permissive than present (a disabled tool / audience exclusion
    // vanishes), so this must NOT silently degrade to "no overrides" — that
    // would fail OPEN. Only ENOENT and a code-less failure (workerd) degrade.
    const root = await tempVendo({ format: VENDO_TOOLS_FORMAT, tools: [] });
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({ format: VENDO_OVERRIDES_FORMAT, tools: {} }));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    readFileMock.mockImplementation(async (path: unknown, ...rest: unknown[]) => {
      if (String(path).endsWith("overrides.json")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    });

    const actions = createActions({ dir: root, tools: [routeTool("host_in_memory")] });
    await expect(actions.descriptors()).rejects.toMatchObject({ name: "VendoError", code: "validation" });
  });
});

describe("format v3 host files (cse lane 1)", () => {
  const compound = (name: string, stepTool: string, extras: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    description: `${name} flow`,
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "compound", steps: [{ id: "a", tool: stepTool }] },
    ...extras,
  });

  it("loads the v3 pair: overrides beat tools, compounds and briefs come from overrides.json", async () => {
    const root = await tempVendo(
      {
        format: VENDO_TOOLS_FORMAT,
        tools: [routeTool("host_probe", {
          audience: "end-user",
          semantics: { "data.amountCents": { kind: "money", unit: "cents" } },
          srcHash: "sha256:1",
        })],
      },
      {
        format: VENDO_OVERRIDES_FORMAT,
        tools: { host_probe: { description: "Overridden host", risk: "write" } },
        compounds: [compound("host_probe_flow", "host_probe", { risk: "write" })],
        briefs: [{ name: "probe", text: "call host_probe first", tools: ["host_probe"] }],
      },
    );
    const actions = createActions({ dir: root });
    await expect(actions.descriptors()).resolves.toEqual([
      { name: "host_probe", description: "Overridden host", inputSchema: { type: "object" }, risk: "write" },
      { name: "host_probe_flow", description: "host_probe_flow flow", inputSchema: { type: "object" }, risk: "write" },
    ]);
    await expect(actions.briefs()).resolves.toEqual([{ name: "probe", text: "call host_probe first", tools: ["host_probe"] }]);
  });

  it("keeps the overrides file strict: a typo fails loudly at load", async () => {
    const root = await tempVendo(
      { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_probe")] },
      { format: VENDO_OVERRIDES_FORMAT, tools: {}, compunds: [] },
    );
    await expect(createActions({ dir: root }).descriptors()).rejects.toMatchObject({
      name: "VendoError",
      code: "validation",
      message: expect.stringContaining("overrides.json"),
    });
  });

  it("warns loudly on orphaned override entries, compound steps, and brief refs — never throws", async () => {
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message: unknown) => { warned.push(String(message)); });
    try {
      const root = await tempVendo(
        { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_probe")] },
        {
          format: VENDO_OVERRIDES_FORMAT,
          tools: {
            host_probe: { description: "Overridden host" },
            host_ghost: { disabled: true },
            ext_write: { risk: "read" },
          },
          compounds: [compound("host_probe_flow", "host_typo")],
          briefs: [{ name: "probe", text: "call host_probe first", tools: ["host_probe", "host_gone"] }],
        },
      );
      const actions = createActions({
        dir: root,
        connectors: [connector([{ name: "ext_write", description: "Write", inputSchema: {}, risk: "write" }])],
      });
      await expect(actions.descriptors()).resolves.toBeDefined();
      const orphanLine = warned.find((line) => line.includes("orphan"));
      expect(orphanLine).toContain("host_ghost");
      expect(orphanLine).toContain("host_typo");
      expect(orphanLine).toContain("host_gone");
      // Overrides on connector tools are not orphans — they merged above.
      expect(orphanLine).not.toContain("ext_write");
    } finally {
      spy.mockRestore();
    }
  });

  it("carries a human `title` from tools.json onto the merged descriptor", async () => {
    const root = await tempVendo(
      { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_transfer", { title: "Send money" } as Partial<ExtractedTool>)] },
      { format: VENDO_OVERRIDES_FORMAT, tools: {} },
    );
    await expect(createActions({ dir: root }).descriptors()).resolves.toEqual([
      { name: "host_transfer", description: "host_transfer", inputSchema: { type: "object" }, risk: "read", title: "Send money" },
    ]);
  });

  it("lets an overrides.json `title` correct the extracted one", async () => {
    const root = await tempVendo(
      { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_transfer", { title: "Post transfer" } as Partial<ExtractedTool>)] },
      { format: VENDO_OVERRIDES_FORMAT, tools: { host_transfer: { title: "Send money" } } },
    );
    await expect(createActions({ dir: root }).descriptors()).resolves.toEqual([
      { name: "host_transfer", description: "host_transfer", inputSchema: { type: "object" }, risk: "read", title: "Send money" },
    ]);
  });

  describe("surfaceMenu (per-surface tool menus)", () => {
    const menuTools = () => [
      routeTool("host_listAccounts"),
      routeTool("host_getProfile", { audience: "end-user" } as Partial<ExtractedTool>),
      routeTool("host_adminPurge", { audience: "operator" } as Partial<ExtractedTool>),
      routeTool("host_webhookSink", { audience: "internal" } as Partial<ExtractedTool>),
      routeTool("host_legacy", { disabled: true } as Partial<ExtractedTool>),
    ];

    it("without a surfaces block the agent is unrestricted and the door defaults to end-user/unset tools", async () => {
      const root = await tempVendo(
        { format: VENDO_TOOLS_FORMAT, tools: menuTools() },
        { format: VENDO_OVERRIDES_FORMAT, tools: {} },
      );
      const actions = createActions({ dir: root });
      await expect(actions.surfaceMenu("agent")).resolves.toBeUndefined();
      await expect(actions.surfaceMenu("mcp")).resolves.toEqual(["host_listAccounts", "host_getProfile"]);
    });

    it("honors an explicit list for each surface independently", async () => {
      const root = await tempVendo(
        { format: VENDO_TOOLS_FORMAT, tools: menuTools() },
        {
          format: VENDO_OVERRIDES_FORMAT,
          tools: {},
          surfaces: {
            agent: { tools: ["host_listAccounts", "host_adminPurge"] },
            mcp: { tools: ["host_getProfile"] },
          },
        },
      );
      const actions = createActions({ dir: root });
      await expect(actions.surfaceMenu("agent")).resolves.toEqual(["host_listAccounts", "host_adminPurge"]);
      await expect(actions.surfaceMenu("mcp")).resolves.toEqual(["host_getProfile"]);
    });

    it("keeps an unmatched menu entry in the list and warns once — a menu is a filter, not a reference", async () => {
      const root = await tempVendo(
        { format: VENDO_TOOLS_FORMAT, tools: menuTools() },
        {
          format: VENDO_OVERRIDES_FORMAT,
          tools: {},
          surfaces: { mcp: { tools: ["host_getProfile", "gmail_send", "host_legacy"] } },
        },
      );
      const warned: string[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((line: string) => { warned.push(line); });
      try {
        const actions = createActions({ dir: root });
        // The whole authored set survives: `gmail_send` may be a lazy connector
        // tool that has not been expanded yet, and dropping it here would make
        // it permanently unreachable once it does arrive.
        await expect(actions.surfaceMenu("mcp")).resolves.toEqual(["host_getProfile", "gmail_send", "host_legacy"]);
        await actions.surfaceMenu("mcp");
        const menuWarnings = warned.filter((line) => line.includes("surfaces.mcp"));
        expect(menuWarnings).toHaveLength(1);
        expect(menuWarnings[0]).toContain("gmail_send");
        expect(menuWarnings[0]).toContain("host_legacy");
      } finally {
        spy.mockRestore();
      }
    });

    it("warns loudly when an authored menu matches nothing at all", async () => {
      const root = await tempVendo(
        { format: VENDO_TOOLS_FORMAT, tools: menuTools() },
        { format: VENDO_OVERRIDES_FORMAT, tools: {}, surfaces: { mcp: { tools: ["nope_one", "nope_two"] } } },
      );
      const warned: string[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((line: string) => { warned.push(line); });
      try {
        await expect(createActions({ dir: root }).surfaceMenu("mcp")).resolves.toEqual(["nope_one", "nope_two"]);
        expect(warned.some((line) => line.includes("surfaces.mcp") && /matches no/i.test(line))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("keeps a disabled tool out of the default door menu too", async () => {
      const root = await tempVendo(
        { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_live"), routeTool("host_legacy")] },
        { format: VENDO_OVERRIDES_FORMAT, tools: { host_legacy: { disabled: true } } },
      );
      await expect(createActions({ dir: root }).surfaceMenu("mcp")).resolves.toEqual(["host_live"]);
    });

    it("reads audience through overrides, not just the extracted grade", async () => {
      const root = await tempVendo(
        { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_a", { audience: "operator" } as Partial<ExtractedTool>), routeTool("host_b")] },
        { format: VENDO_OVERRIDES_FORMAT, tools: { host_a: { audience: "end-user" }, host_b: { audience: "internal" } } },
      );
      await expect(createActions({ dir: root }).surfaceMenu("mcp")).resolves.toEqual(["host_a"]);
    });

    it("fails loudly on a surface name that is not a real surface (closed enum, authored file)", async () => {
      const root = await tempVendo(
        { format: VENDO_TOOLS_FORMAT, tools: [routeTool("host_a")] },
        { format: VENDO_OVERRIDES_FORMAT, tools: {}, surfaces: { cli: { tools: ["host_a"] } } },
      );
      await expect(createActions({ dir: root }).surfaceMenu("mcp")).rejects.toMatchObject({
        name: "VendoError",
        code: "validation",
        message: expect.stringContaining("overrides.json"),
      });
    });
  });
});
