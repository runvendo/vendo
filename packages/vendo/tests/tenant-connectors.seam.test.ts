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
import { tenantConnectorSecret, type Principal, type RunContext } from "@vendoai/core";
import { createStore, eraseStore, secretStore, storeFiles, storeSecrets, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { bootSummaryFor } from "../src/boot-summary.js";
import { createComposition } from "../src/compose-context.js";
import { createVendo, type Vendo } from "../src/server.js";

const ADA: Principal = { kind: "user", subject: "user_ada" };

/** A run as a member of one org — the `memberships` the host asserts per
 *  request (build contract §9.1), which is the only thing that selects an
 *  overlay. */
const runAs = (org: string): RunContext => ({
  principal: ADA,
  venue: "chat",
  presence: "present",
  sessionId: `s_${org}`,
  memberships: [{ org }],
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
 *  proven to travel all the way to the far end. */
async function startMcpServer(tool: string): Promise<{
  url: string;
  authorizations: string[];
  stop: () => Promise<void>;
}> {
  const authorizations: string[] = [];
  const server = createServer((req, res) => void (async (): Promise<void> => {
    const body = await jsonBody(req);
    const { id, method } = body as { id?: unknown; method?: string };
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
  return { url: `http://127.0.0.1:${port}`, authorizations, stop };
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
async function deployment(policy?: "autopilot"): Promise<{ vendo: Vendo; store: VendoStore }> {
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
  });
  return { vendo, store };
}

/** What a run is really offered, off the registry every door executes through. */
const toolNames = async (vendo: Vendo, org: string): Promise<string[]> =>
  (await vendo.guardedTools.descriptors(runAs(org))).map((descriptor) => descriptor.name);

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
