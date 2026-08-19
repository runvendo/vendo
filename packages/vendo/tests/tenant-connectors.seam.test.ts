/**
 * THE TENANT SEAM — a registration written through the real API, and the tools
 * it grows read back through the real guard-bound registry.
 *
 * Everything here is live. The MCP server is a real `node:http` listener
 * speaking real JSON-RPC over the wire, the store is a real PGlite with a real
 * encryption key, and the tool listing comes out of `vendo.guardedTools` — the
 * SAME registry chat, the MCP door and automations execute through. Nothing on
 * either side is stubbed, because the whole claim of this feature is that a
 * producer (register) and a consumer (a turn's tool listing) agree, and two
 * mocks can never disagree.
 *
 * The isolation claim is proven STRUCTURALLY, not by asserting on a filter: the
 * same registry is asked twice, once as a member of the org that registered and
 * once as a member of another, and only the first has the tools.
 *
 * The one that must be able to fail: drop the overlay wrap in compose-actions
 * and phase 2 goes red; make `remove` skip its cache clear and phase 4 goes red.
 */
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { LanguageModel } from "ai";
import {
  tenantConnectorSecret,
  type Json,
  type Principal,
  type RunContext,
  type ToolDefinition,
} from "@vendoai/core";
import { createStore, eraseStore, secretStore, storeFiles, storeSecrets, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  scriptedModel,
  textTurn,
  toolCallTurn,
  type ScriptedModel,
} from "../src/agent-doubles.test-util.js";
import { bootSummaryFor } from "../src/boot-summary.js";
import { createComposition } from "../src/compose-context.js";
import { createVendo, type Vendo } from "../src/server.js";

const ADA: Principal = { kind: "user", subject: "user_ada" };

/** A run as a member of the given orgs, in that order — the `memberships` the
 *  host asserts per request (build contract §9.1), which is the only thing that
 *  selects an overlay. */
const runAs = (...orgs: string[]): RunContext => ({
  principal: ADA,
  venue: "chat",
  presence: "present",
  sessionId: `s_${orgs.join("|")}`,
  memberships: orgs.map((org) => ({ org })),
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** A real MCP server on a real port, advertising one real tool. It records the
 *  authorization header it was called with, which is how the vaulted token is
 *  proven to travel all the way to the far end, and every JSON-RPC method it was
 *  asked for — the only way to prove a server was NEVER reached. */
async function startMcpServer(tool: string): Promise<{
  url: string;
  authorizations: string[];
  calls: string[];
  stop: () => Promise<void>;
}> {
  const authorizations: string[] = [];
  const calls: string[] = [];
  const server = createServer((req, res) => void (async (): Promise<void> => {
    const body = await jsonBody(req);
    const { id, method } = body as { id?: unknown; method?: string };
    if (typeof method === "string") calls.push(method);
    if (typeof req.headers.authorization === "string") authorizations.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (method === "initialize") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26" } }));
      return;
    }
    if (method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (method === "tools/list") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools: [{ name: tool, description: `${tool} for this tenant`, inputSchema: {} }] },
      }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } }));
  })());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(stop);
  return { url: `http://127.0.0.1:${port}`, authorizations, calls, stop };
}

/** The spec ONE tenant pastes. `servers[0]` is deliberately somewhere else, so
 *  every call that lands proves the registration's own `url` won as the base. */
const LEDGER_SPEC = {
  openapi: "3.1.0",
  info: { title: "Acme Ledger", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:1" }],
  paths: {
    "/accounts/{id}": {
      get: {
        operationId: "getAccount",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {},
      },
    },
  },
};

/** A real REST API on a real port — the far end the spec above describes. Like
 *  the MCP fixture it records what actually arrived, which is how the vaulted
 *  token is proven to travel the whole way. */
async function startRestApi(): Promise<{
  url: string;
  authorizations: string[];
  paths: string[];
  stop: () => Promise<void>;
}> {
  const authorizations: string[] = [];
  const paths: string[] = [];
  const server = createServer((req, res) => {
    if (typeof req.headers.authorization === "string") authorizations.push(req.headers.authorization);
    paths.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: (req.url ?? "").split("/").pop(), balance: 4200 }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(stop);
  return { url: `http://127.0.0.1:${port}`, authorizations, paths, stop };
}

/** A real deployment over a real encrypted store. `policy` is unset for every
 *  listing test — a tenant tool's RISK is the guard's business, not this seam's,
 *  and unset is the posture the rest of this file exercises. Only the test that
 *  executes one passes a policy, so the guard runs the call instead of parking
 *  it for approval (an OpenAPI GET grades `ungraded`, which asks by default). */
async function deployment(
  policy?: "autopilot",
  tools?: ToolDefinition[],
): Promise<{ vendo: Vendo; store: VendoStore }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-tenant-connectors-"));
  const store = createStore({ dataDir, encryption: { key: randomBytes(32).toString("base64") } });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => ADA,
    store,
    profileDir: dataDir,
    ...(policy === undefined ? {} : { guard: { policy } }),
    ...(tools === undefined ? {} : { tools }),
  });
  return { vendo, store };
}

/** What a run is really offered, off the registry every door executes through. */
const toolNames = async (vendo: Vendo, ...orgs: string[]): Promise<string[]> =>
  (await vendo.guardedTools.descriptors(runAs(...orgs))).map((descriptor) => descriptor.name);

describe("a tenant registers its own MCP server", () => {
  it("registers by connecting, and hands back the tools the server really advertised", async () => {
    const { vendo } = await deployment();
    const server = await startMcpServer("lookup_invoice");

    const result = await vendo.tenantConnectors.register({
      org: "acme",
      name: "billing",
      kind: "mcp",
      url: server.url,
      token: "tok_acme_live",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The names come off the live handshake, not off anything this test wrote.
    expect(result.tools.map((tool) => tool.name)).toEqual(["mcp_billing_lookup_invoice"]);
    expect(server.authorizations).toContain("Bearer tok_acme_live");
  });

  it("grows the registering org's agent, and ONLY that org's", async () => {
    const { vendo } = await deployment();
    const acme = await startMcpServer("lookup_invoice");

    const before = await toolNames(vendo, "acme");
    expect(before).not.toContain("mcp_billing_lookup_invoice");

    await vendo.tenantConnectors.register({
      org: "acme", name: "billing", kind: "mcp", url: acme.url, token: "tok_acme_live",
    });

    // Structural, not filtered: globex is served a registry the connector was
    // never in, so there is nothing here for a filter to have got wrong.
    expect(await toolNames(vendo, "acme")).toContain("mcp_billing_lookup_invoice");
    expect(await toolNames(vendo, "globex")).not.toContain("mcp_billing_lookup_invoice");
    // …and the shared surface is untouched: the host's own tools are still there.
    const shared = await toolNames(vendo, "globex");
    expect(await toolNames(vendo, "acme")).toEqual(expect.arrayContaining(shared));
  });

  it("keeps two tenants' servers apart, each seeing only its own", async () => {
    const { vendo } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    const globex = await startMcpServer("ship_order");

    await vendo.tenantConnectors.register({ org: "acme", name: "billing", kind: "mcp", url: acme.url });
    await vendo.tenantConnectors.register({ org: "globex", name: "logistics", kind: "mcp", url: globex.url });

    expect(await toolNames(vendo, "acme")).toContain("mcp_billing_lookup_invoice");
    expect(await toolNames(vendo, "acme")).not.toContain("mcp_logistics_ship_order");
    expect(await toolNames(vendo, "globex")).toContain("mcp_logistics_ship_order");
    expect(await toolNames(vendo, "globex")).not.toContain("mcp_billing_lookup_invoice");
  });

  it("takes the tools away on the next request after remove", async () => {
    const { vendo } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({ org: "acme", name: "billing", kind: "mcp", url: acme.url });
    // Read once so the overlay is genuinely CACHED before the removal.
    expect(await toolNames(vendo, "acme")).toContain("mcp_billing_lookup_invoice");

    await vendo.tenantConnectors.remove("acme", "billing");

    expect(await toolNames(vendo, "acme")).not.toContain("mcp_billing_lookup_invoice");
    expect(await vendo.tenantConnectors.list("acme")).toEqual([]);
  });

  it("lists a registration without its credential, ever", async () => {
    const { vendo } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({
      org: "acme", name: "billing", kind: "mcp", url: acme.url, token: "tok_acme_live",
    });

    const summaries = await vendo.tenantConnectors.list("acme");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ org: "acme", name: "billing", kind: "mcp", url: acme.url });
    expect(summaries[0]?.registeredAt).toEqual(expect.any(String));
    expect(JSON.stringify(summaries)).not.toContain("tok_acme_live");
  });

  it("round-trips the token through the real encrypted secrets store", async () => {
    const { vendo, store } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({
      org: "acme", name: "billing", kind: "mcp", url: acme.url, token: "tok_acme_live",
    });

    // Read back through the store's own secrets door — the value is there…
    expect(await storeSecrets(store).get(tenantConnectorSecret("acme", "billing"))).toBe("tok_acme_live");
    // …and the row it came out of is ciphertext, not the token.
    const rows = (await (store.raw() as { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> })
      .query("SELECT ciphertext FROM vendo_secrets")).rows;
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.["ciphertext"])).not.toContain("tok_acme_live");
    // The registration row itself never held it either.
    const record = await store.records("vendo_tenant_connectors").list({ refs: { subject: "acme" } });
    expect(JSON.stringify(record.records)).not.toContain("tok_acme_live");

    // And it reaches the far end: the overlay's own handshake carries it.
    acme.authorizations.length = 0;
    await vendo.guardedTools.descriptors(runAs("acme"));
    expect(acme.authorizations).toContain("Bearer tok_acme_live");
  });

  it("never sends the old token to a url the tenant re-registered without one", async () => {
    const { vendo, store } = await deployment();
    const original = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({
      org: "acme", name: "billing", kind: "mcp", url: original.url, token: "tok_acme_live",
    });
    expect(await storeSecrets(store).get(tenantConnectorSecret("acme", "billing"))).toBe("tok_acme_live");

    // The tenant moves its server and pastes no token this time. `register`
    // validated against the new url with NO credential, so that is what every
    // later call must use too.
    const moved = await startMcpServer("lookup_invoice");
    const result = await vendo.tenantConnectors.register({
      org: "acme", name: "billing", kind: "mcp", url: moved.url,
    });

    expect(result.status).toBe("ok");
    expect(await storeSecrets(store).get(tenantConnectorSecret("acme", "billing"))).toBeUndefined();
    moved.authorizations.length = 0;
    await vendo.guardedTools.descriptors(runAs("acme"));
    expect(moved.calls).toContain("tools/list");
    expect(moved.authorizations).toEqual([]);
  });

  it("serves a tokenless registration on a store with no vault at all", async () => {
    // No encryption key: this store REFUSES to read a secret before it even
    // looks for a row (store/secrets.ts). A connector that needs no credential
    // must therefore never ask, or one tokenless registration takes down every
    // turn for every member of the org.
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-tenant-novault-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    await store.ensureSchema();
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => ADA,
      store,
      profileDir: dataDir,
    });
    const server = await startMcpServer("lookup_invoice");

    const result = await vendo.tenantConnectors.register({
      org: "acme", name: "billing", kind: "mcp", url: server.url,
    });
    expect(result.status).toBe("ok");

    // The listing a turn is served, on a store that cannot vault anything.
    expect(await toolNames(vendo, "acme")).toContain("mcp_billing_lookup_invoice");
    expect(await vendo.tenantConnectors.test("acme", "billing")).toMatchObject({ status: "ok" });
  });

  it("answers a typed error when the tenant's server is down", async () => {
    const { vendo } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({ org: "acme", name: "billing", kind: "mcp", url: acme.url });

    await acme.stop();

    const result = await vendo.tenantConnectors.test("acme", "billing");
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe("unavailable");
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  it("names the registration that was never made", async () => {
    const { vendo } = await deployment();
    const result = await vendo.tenantConnectors.test("acme", "nothing");
    expect(result).toMatchObject({ status: "error", error: { code: "not-found" } });
  });

  it("refuses a registration that cannot connect, and stores nothing", async () => {
    const { vendo } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    const url = acme.url;
    await acme.stop();

    const result = await vendo.tenantConnectors.register({ org: "acme", name: "billing", kind: "mcp", url });

    expect(result.status).toBe("error");
    expect(await vendo.tenantConnectors.list("acme")).toEqual([]);
  });

  it("goes with the org when the erase cascade sweeps it — rows AND live token", async () => {
    const { vendo, store } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({
      org: "acme", name: "billing", kind: "mcp", url: acme.url, token: "tok_acme_live",
    });
    await vendo.tenantConnectors.register({
      org: "globex", name: "logistics", kind: "mcp", url: acme.url, token: "tok_globex_live",
    });
    // The credential really is in the vault before the sweep, or the assertion
    // after it proves nothing.
    expect(await storeSecrets(store).get(tenantConnectorSecret("acme", "billing"))).toBe("tok_acme_live");

    // The store's own cascade: an org id IS a row subject, so the registrations
    // are reached by the stamp they were written with, and the token by the org
    // its vault name carries.
    const report = await eraseStore(store, { files: storeFiles(store) }).bySubject("acme");

    expect(report.vendo_records).toBeGreaterThanOrEqual(1);
    expect(report.vendo_secrets).toBe(1);
    expect(await vendo.tenantConnectors.list("acme")).toEqual([]);
    expect(await storeSecrets(store).get(tenantConnectorSecret("acme", "billing"))).toBeUndefined();
  });

  it("leaves the other tenant's token exactly where it was", async () => {
    const { vendo, store } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({
      org: "acme", name: "billing", kind: "mcp", url: acme.url, token: "tok_acme_live",
    });
    await vendo.tenantConnectors.register({
      org: "globex", name: "logistics", kind: "mcp", url: acme.url, token: "tok_globex_live",
    });
    // A host secret of the deployment's own, which belongs to nobody and must
    // survive every erasure.
    await secretStore(store).set("API_TOKEN", "host_owned");

    await eraseStore(store, { files: storeFiles(store) }).bySubject("acme");

    expect(await vendo.tenantConnectors.list("globex")).toHaveLength(1);
    expect(await storeSecrets(store).get(tenantConnectorSecret("globex", "logistics"))).toBe("tok_globex_live");
    expect(await storeSecrets(store).get("API_TOKEN")).toBe("host_owned");
  });
});

describe("a person who belongs to two orgs", () => {
  it("keeps every tool when both orgs chose the SAME connector name", async () => {
    const { vendo } = await deployment();
    const acme = await startMcpServer("lookup_invoice");
    const globex = await startMcpServer("lookup_invoice");
    // Both tenants called their connector "billing", so both compose the tool
    // name `mcp_billing_lookup_invoice`. One shared registry answers that with a
    // conflict throw and serves NOTHING — host tools included — to a person
    // whose only mistake was belonging to both.
    await vendo.tenantConnectors.register({ org: "acme", name: "billing", kind: "mcp", url: acme.url });
    await vendo.tenantConnectors.register({ org: "globex", name: "billing", kind: "mcp", url: globex.url });

    const both = await toolNames(vendo, "acme", "globex");
    // The shared surface is whole — the collision took nothing with it.
    expect(both).toEqual(expect.arrayContaining(await toolNames(vendo, "unregistered")));
    // ...and the colliding name is offered exactly ONCE, or the model has two
    // tools it cannot tell apart and no way to address either.
    expect(both.filter((name) => name === "mcp_billing_lookup_invoice")).toHaveLength(1);
  });

  it("runs the first org it asserted, which is the one the listing offered", async () => {
    const { vendo } = await deployment("autopilot");
    const acme = await startMcpServer("lookup_invoice");
    const globex = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({ org: "acme", name: "billing", kind: "mcp", url: acme.url });
    await vendo.tenantConnectors.register({ org: "globex", name: "billing", kind: "mcp", url: globex.url });
    // Both were reached while the registries were built; only the call matters.
    await toolNames(vendo, "globex", "acme");
    acme.calls.length = 0;
    globex.calls.length = 0;

    await vendo.guardedTools.execute(
      { id: "call_collide", tool: "mcp_billing_lookup_invoice", args: {} },
      runAs("globex", "acme"),
    );

    expect(globex.calls).toContain("tools/call");
    expect(acme.calls).not.toContain("tools/call");
  });

  it("cannot confuse one org named \"a,b\" with membership in a and b", async () => {
    const { vendo } = await deployment();
    const server = await startMcpServer("lookup_invoice");
    await vendo.tenantConnectors.register({ org: "a", name: "billing", kind: "mcp", url: server.url });

    // A cache keyed by the joined membership list read these two as the same
    // caller, and handed org "a,b" the tools of orgs a and b.
    expect(await toolNames(vendo, "a", "b")).toContain("mcp_billing_lookup_invoice");
    expect(await toolNames(vendo, "a,b")).not.toContain("mcp_billing_lookup_invoice");
  });
});

/** A host tool named exactly what the tenant registration below will compose
 *  (`mcp_<registration>_<tool>`), so the two genuinely collide. */
const SHADOW_HOST_TOOL: ToolDefinition = {
  name: "mcp_shadow_probe",
  title: "The host's own probe",
  description: "The host's own tool, which a tenant must never displace.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  execute: async () => ({ ran: "host" }) as unknown as Json,
};

describe("a tenant that names a tool after a host tool", () => {
  it("is offered once, and it is the HOST's tool that runs", async () => {
    const { vendo } = await deployment("autopilot", [SHADOW_HOST_TOOL]);
    const tenant = await startMcpServer("probe");
    await vendo.tenantConnectors.register({ org: "acme", name: "shadow", kind: "mcp", url: tenant.url });

    const offered = await toolNames(vendo, "acme");
    expect(offered.filter((name) => name === "mcp_shadow_probe")).toHaveLength(1);

    tenant.calls.length = 0;
    const outcome = await vendo.guardedTools.execute(
      { id: "call_shadow", tool: "mcp_shadow_probe", args: {} },
      runAs("acme"),
    );

    expect(outcome).toMatchObject({ status: "ok", output: { ran: "host" } });
    // The tenant's server was never even asked — the shadowing is structural.
    expect(tenant.calls).toEqual([]);
  });
});

describe("a tenant registers its own OpenAPI spec", () => {
  it("registers by reading the spec, and hands back the tools it really declares", async () => {
    const { vendo } = await deployment();
    const api = await startRestApi();

    const result = await vendo.tenantConnectors.register({
      org: "acme",
      name: "ledger",
      kind: "openapi",
      url: api.url,
      spec: LEDGER_SPEC,
      token: "tok_acme_rest",
    });

    // The whole point of the swap: this path used to refuse with
    // `not-implemented`, and now answers with the operations the spec declares.
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.tools.map((tool) => tool.name)).toEqual(["openapi_ledger_getAccount"]);
  });

  it("grows the registering org's agent, and ONLY that org's", async () => {
    const { vendo } = await deployment();
    const api = await startRestApi();

    await vendo.tenantConnectors.register({
      org: "acme", name: "ledger", kind: "openapi", url: api.url, spec: LEDGER_SPEC,
    });

    expect(await toolNames(vendo, "acme")).toContain("openapi_ledger_getAccount");
    expect(await toolNames(vendo, "globex")).not.toContain("openapi_ledger_getAccount");
  });

  it("calls the tenant's own API for real, carrying the vaulted token", async () => {
    const { vendo } = await deployment("autopilot");
    const api = await startRestApi();
    await vendo.tenantConnectors.register({
      org: "acme", name: "ledger", kind: "openapi", url: api.url, spec: LEDGER_SPEC, token: "tok_acme_rest",
    });

    // Through the SAME registry every door executes through — and out to a
    // server that is genuinely listening.
    const outcome = await vendo.guardedTools.execute(
      { id: "call_1", tool: "openapi_ledger_getAccount", args: { id: "acc_1" } },
      runAs("acme"),
    );

    expect(outcome).toEqual({ status: "ok", output: { id: "acc_1", balance: 4200 } });
    // The registration's url beat the spec's own `servers[0]`, and the token
    // came back out of the vault to ride the request.
    expect(api.paths).toEqual(["/accounts/acc_1"]);
    expect(api.authorizations).toEqual(["Bearer tok_acme_rest"]);
  });

  it("refuses a spec-less openapi registration by naming what is missing", async () => {
    const { vendo } = await deployment();

    const result = await vendo.tenantConnectors.register({ org: "acme", name: "ledger", kind: "openapi" });

    expect(result).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(await vendo.tenantConnectors.list("acme")).toEqual([]);
  });
});

/**
 * THE CHAT SEAM — the half a correct registry cannot prove.
 *
 * `vendo.guardedTools` resolving a tenant's tools says nothing about whether the
 * AGENT can reach them, and for one release it could not: the discovery hand
 * searched the shared registry, which has no caller and therefore no tenant, so
 * org A's turn answered exactly like org B's while the registry was right the
 * whole time. These drive a REAL turn through `vendo.handler` with a scripted
 * model, and read what the model was actually offered on its second step.
 */
describe("the agent can reach a tenant's tools in a real turn", () => {
  async function chatting(turns: Parameters<typeof scriptedModel>[0]): Promise<{
    vendo: Vendo;
    model: ScriptedModel;
    chat: (as: string, text: string) => Promise<Response>;
  }> {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-tenant-chat-"));
    const store = createStore({ dataDir, encryption: { key: randomBytes(32).toString("base64") } });
    cleanups.push(async () => {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    await store.ensureSchema();
    const model = scriptedModel(turns);
    const vendo = createVendo({
      models: { default: model as unknown as LanguageModel },
      // A real memberships seam: the wire resolves the caller's org per request,
      // which is the only thing that selects an overlay.
      auth: {
        principal: async (req: Request) => ({
          kind: "user" as const,
          subject: req.headers.get("x-user") ?? "user_globex",
        }),
        memberships: async (principal: Principal) => [
          { org: principal.subject === "user_acme" ? "acme" : "globex" },
        ],
      },
      store,
      profileDir: dataDir,
      guard: { policy: "autopilot" },
      // A hard cap, so the tenant tool is genuinely PAST the belt and the only
      // way to it is the discovery hand. Without this the deployment's surface
      // fits under the default cap, every tool starts active, and the test would
      // pass without `find_tools` ever mattering.
      maxInitialTools: 1,
    });
    const chat = async (as: string, text: string): Promise<Response> => {
      const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": as },
        body: JSON.stringify({
          message: { id: `m_${globalThis.crypto.randomUUID()}`, role: "user", parts: [{ type: "text", text }] },
        }),
      }));
      await response.text();
      return response;
    };
    return { vendo, model, chat };
  }

  it("finds one through find_tools and calls it on the very next step", async () => {
    const server = await startMcpServer("lookup_invoice");
    const { vendo, model, chat } = await chatting([
      toolCallTurn("find_tools", { query: "lookup invoice" }),
      toolCallTurn("mcp_billing_lookup_invoice", {}, "c2"),
      textTurn("You have one open invoice."),
    ]);
    await vendo.tenantConnectors.register({ org: "acme", name: "billing", kind: "mcp", url: server.url });
    server.calls.length = 0;

    const turn = await chat("user_acme", "look up my invoice");
    expect(turn.status).toBe(200);

    // Step one could not call it — it is past the belt, so the only way to it is
    // the hand...
    expect(model.toolNamesPerCall[0]).not.toContain("mcp_billing_lookup_invoice");
    expect(model.toolNamesPerCall[0]).toContain("find_tools");
    // ...step two has it, because `find_tools` searched the set THIS caller is
    // served and loaded what it found...
    expect(model.toolNamesPerCall[1]).toContain("mcp_billing_lookup_invoice");
    // ...and the tenant's own server really ran the call.
    expect(server.calls).toContain("tools/call");
  });

  it("hides it from a member of another org, who searches and finds nothing", async () => {
    const server = await startMcpServer("lookup_invoice");
    const { vendo, model, chat } = await chatting([
      toolCallTurn("find_tools", { query: "lookup invoice" }),
      textTurn("I don't have a tool for that."),
    ]);
    await vendo.tenantConnectors.register({ org: "acme", name: "billing", kind: "mcp", url: server.url });
    server.calls.length = 0;

    await chat("user_globex", "look up my invoice");

    expect(model.toolNamesPerCall[1]).not.toContain("mcp_billing_lookup_invoice");
    // The other tenant's server was never even spoken to.
    expect(server.calls).toEqual([]);
  });
});

describe("the boot block reports the seam only when it can serve", () => {
  const rowsFor = (auth?: { principal: () => Promise<Principal>; memberships?: () => Promise<[]> }): string[] =>
    bootSummaryFor(createComposition(
      auth === undefined
        ? { principal: async () => ADA, models: { default: {} as LanguageModel } }
        : { auth, models: { default: {} as LanguageModel } },
    )).rows.map((row) => row.label);

  it("says nothing without a memberships seam — no run can assert an org", () => {
    expect(rowsFor()).not.toContain("tenants");
  });

  it("earns its row once the host can assert one", () => {
    expect(rowsFor({ principal: async () => ADA, memberships: async () => [] })).toContain("tenants");
  });
});
