/**
 * 10-mcp §1 / 10-mcp-umbrella-hookup — the one-flag hookup, end to end.
 *
 * Where the other e2e files hand-compose `createMcpDoor` (harness.ts), this file
 * proves the umbrella wiring itself: a single `createVendo({ mcp: true, oauth,
 * actAs })` mounts the door, serves the origin-root discovery documents, and
 * routes host-tool calls through the SAME guard-bound registry chat/apps use —
 * with venue="mcp" host auth flowing through the ActAs seam (04 §4 / 10-mcp §3),
 * never a browser cookie the MCP user does not have.
 *
 * The MCP client is the real SDK (support.ts). Host tools resolve against the
 * fixture host app (global-setup boots it); the umbrella is served on its own
 * loopback origin, so the door and the host API are genuinely separate origins.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_TOOLS_FORMAT, type Principal } from "@vendoai/core";
import type { HostOAuthAdapter } from "@vendoai/mcp";
import { createStore, type VendoStore } from "@vendoai/store";
import { createVendo, type CreateVendoConfig, type Vendo } from "@vendoai/vendo/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_APP_ID, fixtureBaseUrl, hostTools, loginCookie, resetFixture, SUBJECT, type Stack } from "./harness.js";
import { connectWithSdk, descriptorShape, textOf } from "./support.js";

const MCP_PATH = "/api/vendo/mcp";

interface Umbrella {
  vendo: Vendo;
  origin: string;
  endpoint: string;
  actAs: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

const open: Umbrella[] = [];
let projectDir: string;
let originalCwd: string;

// createVendo builds its actions registry from `.vendo/tools.json` in cwd and
// resolves route bindings against VENDO_BASE_URL. Point both at the fixture host
// the way a real host would: its own project dir + its own origin (trusted).
beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "vendo-umbrella-project-"));
  await mkdir(join(projectDir, ".vendo"), { recursive: true });
  await writeFile(
    join(projectDir, ".vendo", "tools.json"),
    JSON.stringify({ format: VENDO_TOOLS_FORMAT, tools: hostTools }),
  );
  originalCwd = process.cwd();
  process.chdir(projectDir);
  process.env.VENDO_BASE_URL = fixtureBaseUrl();
});

afterAll(async () => {
  process.chdir(originalCwd);
  delete process.env.VENDO_BASE_URL;
  await rm(projectDir, { recursive: true, force: true });
});

beforeEach(resetFixture);

afterEach(async () => {
  for (const umbrella of open.splice(0).reverse()) await umbrella.close();
  vi.restoreAllMocks();
});

async function createUmbrella(
  options: { withActAs?: boolean; principalReturnsNull?: boolean } = {},
): Promise<Umbrella> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-umbrella-store-"));
  const store: VendoStore = createStore({ dataDir });
  const oauth: HostOAuthAdapter = {
    // Auto consent: the fixture host has already authenticated SUBJECT.
    async authorize() {
      return { subject: SUBJECT };
    },
    async principal(subject) {
      if (options.principalReturnsNull === true) return null;
      return { kind: "user", subject, display: `Fixture ${subject}` } satisfies Principal;
    },
  };
  // ActAs mints the host session for the OAuth'd user — "act as this user". The
  // fixture host authenticates on a `fixture_session` cookie, so a real response
  // can ONLY come from this material, never from a forwarded browser cookie.
  const actAs = vi.fn(async (principal: Principal) => ({
    headers: { cookie: `fixture_session=${principal.subject}` },
  }));
  const config: CreateVendoConfig = {
    model: {} as unknown as CreateVendoConfig["model"],
    // The wire's own principal resolver (used by /approvals/decide): the approving
    // user is identified from a first-party cookie the host sets in-product.
    principal: async (req) => {
      const match = (req.headers.get("cookie") ?? "").match(/vendo_user=([^;]+)/);
      return match ? ({ kind: "user", subject: match[1]! } satisfies Principal) : null;
    },
    store,
    // The shipped posture (05 §3): reads run, destructive asks. venue="mcp" gets
    // the identical treatment chat does (10-mcp §2) — no weaker door perimeter.
    policy: {
      rules: [
        { match: { risk: "destructive" }, action: "ask" },
        { match: { risk: "read" }, action: "run" },
        { match: { risk: "write" }, action: "run" },
      ],
    },
    mcp: true,
    oauth,
    ...(options.withActAs === false ? {} : { actAs }),
  };
  const vendo = createVendo(config);
  const httpServer = createServer((req, res) => void bridge(req, res, vendo.handler));
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("umbrella server did not bind a port");
  const origin = `http://127.0.0.1:${address.port}`;
  const umbrella: Umbrella = {
    vendo,
    origin,
    endpoint: `${origin}${MCP_PATH}`,
    actAs,
    async close() {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  open.push(umbrella);
  return umbrella;
}

/** connectWithSdk (support.ts) only reads `.endpoint`; the cast keeps that reuse. */
function asStack(umbrella: Umbrella): Stack {
  return umbrella as unknown as Stack;
}

/** Seed a rung-1 app owned by SUBJECT so a vendo_apps_call can resolve it.
 * createVendo starts store.ensureSchema() without blocking construction (the
 * wire handler awaits it per-request), so a DIRECT store write must await it
 * itself or the vendo_apps table may not exist yet. */
async function seedApp(umbrella: Umbrella): Promise<void> {
  await umbrella.vendo.store.ensureSchema();
  await umbrella.vendo.store.records("vendo_apps").put({
    id: FIXTURE_APP_ID,
    data: {
      subject: SUBJECT,
      enabled: false,
      doc: {
        format: "vendo/app@1",
        id: FIXTURE_APP_ID,
        name: "Umbrella invoice app",
        description: "A rung-1 app for the umbrella apps-call leg.",
        tree: {
          formatVersion: "vendo-genui/v1",
          root: "root",
          nodes: [{ id: "root", component: "Text", props: { children: "Umbrella fixture" } }],
        },
      },
    },
    refs: { subject: SUBJECT },
  });
}

async function umbrellaSql<Row = Record<string, unknown>>(umbrella: Umbrella, query: string, params?: unknown[]): Promise<Row[]> {
  const raw = umbrella.vendo.store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };
  return (await raw.query(query, params)).rows as Row[];
}

describe("umbrella hookup — createVendo({ mcp: true }) mounts the door", () => {
  it("throws synchronously when mcp is enabled without an oauth adapter", () => {
    expect(() => createVendo({
      model: {} as unknown as CreateVendoConfig["model"],
      principal: async () => null,
      mcp: true,
    })).toThrow(/oauth/i);
  });

  it("a) challenges an unauthenticated door call and serves discovery at the origin root", async () => {
    const umbrella = await createUmbrella();
    const challenge = await fetch(umbrella.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const resourceMetadataUrl = `${umbrella.origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${resourceMetadataUrl}"`,
    );

    const protectedResource = await fetch(resourceMetadataUrl);
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toEqual({
      resource: umbrella.endpoint,
      authorization_servers: [umbrella.endpoint],
      bearer_methods_supported: ["header"],
    });

    const authorizationMetadataUrl = `${umbrella.origin}/.well-known/oauth-authorization-server${MCP_PATH}`;
    const authorizationMetadata = await fetch(authorizationMetadataUrl);
    expect(authorizationMetadata.status).toBe(200);
    expect(await authorizationMetadata.json()).toMatchObject({
      issuer: umbrella.endpoint,
      authorization_endpoint: `${umbrella.endpoint}/authorize`,
      token_endpoint: `${umbrella.endpoint}/token`,
      registration_endpoint: `${umbrella.endpoint}/register`,
    });

    const card = await fetch(`${umbrella.origin}/.well-known/mcp/server-card.json`);
    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({ name: expect.any(String), transports: expect.any(Array) });
  });

  it("b) completes the real SDK OAuth round trip and lists the bound registry verbatim", async () => {
    const umbrella = await createUmbrella();
    const connected = await connectWithSdk(asStack(umbrella));
    try {
      const listed = await connected.client.listTools();
      const hostNames = new Set(hostTools.map(({ name }) => name));
      const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
      const fromSdk = listed.tools.filter((tool) => hostNames.has(tool.name as never)).map(descriptorShape).sort(byName);
      const fromRegistry = (await umbrella.vendo.actions.descriptors())
        .filter((descriptor) => hostNames.has(descriptor.name as never))
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        .sort(byName);
      expect(fromSdk).toEqual(fromRegistry);
      // The apps ride-along tools are advertised too (the umbrella passed AppsPort).
      expect(listed.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "vendo_apps_list",
        "vendo_apps_open",
        "vendo_apps_call",
      ]));
    } finally {
      await connected.close();
    }
  });

  it("c) executes a read host tool for real, authenticated via actAs as the OAuth'd user", async () => {
    const umbrella = await createUmbrella();
    const connected = await connectWithSdk(asStack(umbrella));
    try {
      const call = await connected.client.callTool({ name: "host_invoices_list", arguments: {} });
      expect(call.isError, `read tool errored: ${textOf(call)}`).not.toBe(true);
      expect(JSON.parse(textOf(call))).toMatchObject({
        invoices: expect.arrayContaining([expect.objectContaining({ id: "inv_0003" })]),
      });
      // The host was reached through the ActAs seam as the OAuth'd user, not via a
      // forwarded browser session (the door ctx carries no requestHeaders at all).
      expect(umbrella.actAs).toHaveBeenCalled();
      expect(umbrella.actAs.mock.calls[0]?.[0]).toMatchObject({ subject: SUBJECT });
      expect(umbrella.actAs.mock.calls[0]?.[1]).toMatchObject({ source: "mcp", scope: { kind: "tool" } });
    } finally {
      await connected.close();
    }
  });

  it("d) parks a destructive write, approves it through the wire, and really deletes on retry", async () => {
    const umbrella = await createUmbrella();
    const connected = await connectWithSdk(asStack(umbrella));
    try {
      const parked = await connected.client.callTool({
        name: "host_invoices_delete",
        arguments: { id: "inv_0003" },
      });
      expect(parked.isError).toBe(true);
      const approvalId = textOf(parked).match(/apr_[0-9a-f-]+/)?.[0];
      expect(approvalId).toMatch(/^apr_/);

      // Decide through the umbrella's OWN wire (/approvals/decide), authenticated
      // with the first-party cookie the wire's principal resolver recognizes — a
      // standing tool grant so the retry runs without re-parking.
      const decided = await fetch(`${umbrella.origin}/api/vendo/approvals/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `vendo_user=${SUBJECT}` },
        body: JSON.stringify({
          ids: [approvalId],
          decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
        }),
      });
      expect(decided.status).toBe(200);

      const retried = await connected.client.callTool({
        name: "host_invoices_delete",
        arguments: { id: "inv_0003" },
      });
      expect(retried.isError, `delete retry errored: ${textOf(retried)}`).not.toBe(true);
      expect(JSON.parse(textOf(retried))).toEqual({ ok: true });

      // Real host-side side effect: the invoice is gone from the fixture db.
      const check = await fetch(`${fixtureBaseUrl()}/api/invoices/inv_0003`, {
        headers: { cookie: await loginCookie(SUBJECT) },
      });
      expect(check.status).toBe(404);
    } finally {
      await connected.close();
    }
  });

  it("g) runs a vendo_apps_call whose ref is a HOST tool, authenticated via actAs (FIX A)", async () => {
    const umbrella = await createUmbrella();
    await seedApp(umbrella);
    const connected = await connectWithSdk(asStack(umbrella));
    try {
      const called = await connected.client.callTool({
        name: "vendo_apps_call",
        arguments: {
          appId: FIXTURE_APP_ID,
          ref: "host_invoices_update",
          args: { id: "inv_0003", memo: "updated via app over MCP" },
        },
      });
      // apps re-contextualizes the in-app host ref to venue="app", but the door's
      // mcpConsent survives the spread — so the host is still reached through the
      // ActAs seam as the OAuth'd user, never a forwarded cookie (FIX A). Before
      // FIX A this fell to the unauthenticated present-forward path and only the
      // harness's cookie mask (now removed) hid the failure.
      expect(called.isError, `app call errored: ${textOf(called)}`).not.toBe(true);
      expect(textOf(called)).toContain("updated via app over MCP");
      expect(umbrella.actAs).toHaveBeenCalled();
      expect(umbrella.actAs.mock.calls.at(-1)?.[1]).toMatchObject({ source: "mcp", scope: { kind: "tool" } });

      // Real host side effect: the fixture invoice memo actually changed.
      const check = await fetch(`${fixtureBaseUrl()}/api/invoices/inv_0003`, {
        headers: { cookie: await loginCookie(SUBJECT) },
      });
      expect(await check.json()).toMatchObject({ invoice: { memo: "updated via app over MCP" } });
    } finally {
      await connected.close();
    }
  });

  it("h) a one-off approval (no remember) authorizes an MCP retry via the consent projection (FIX B)", async () => {
    const umbrella = await createUmbrella();
    const connected = await connectWithSdk(asStack(umbrella));
    try {
      const parked = await connected.client.callTool({
        name: "host_invoices_delete",
        arguments: { id: "inv_0003" },
      });
      expect(parked.isError).toBe(true);
      const approvalId = textOf(parked).match(/apr_[0-9a-f-]+/)?.[0];
      expect(approvalId).toMatch(/^apr_/);

      // Approve WITHOUT remember: a one-off that mints NO standing grant.
      const decided = await fetch(`${umbrella.origin}/api/vendo/approvals/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `vendo_user=${SUBJECT}` },
        body: JSON.stringify({ ids: [approvalId], decision: { approve: true } }),
      });
      expect(decided.status).toBe(200);

      // Retry the IDENTICAL call: the door reuses the parked ToolCall id (FIX B),
      // so guard's single-use approval replays and the call runs — authenticated
      // by the per-call consent projection, not a stored grant.
      const retried = await connected.client.callTool({
        name: "host_invoices_delete",
        arguments: { id: "inv_0003" },
      });
      expect(retried.isError, `retry errored: ${textOf(retried)}`).not.toBe(true);
      expect(JSON.parse(textOf(retried))).toEqual({ ok: true });

      // The projection is never persisted: no MCP-sourced grant row exists.
      expect(await umbrellaSql(umbrella, "SELECT id FROM vendo_grants WHERE source = 'mcp'")).toEqual([]);

      // Real host side effect: the invoice is gone.
      const check = await fetch(`${fixtureBaseUrl()}/api/invoices/inv_0003`, {
        headers: { cookie: await loginCookie(SUBJECT) },
      });
      expect(check.status).toBe(404);

      // The one-off approval is spent: a THIRD identical call parks again.
      const reparked = await connected.client.callTool({
        name: "host_invoices_delete",
        arguments: { id: "inv_0003" },
      });
      expect(reparked.isError).toBe(true);
      expect(textOf(reparked)).toMatch(/apr_/);
    } finally {
      await connected.close();
    }
  });

  it("e) rejects an oauth principal() that resolves to null", async () => {
    const umbrella = await createUmbrella({ principalReturnsNull: true });
    await expect(connectWithSdk(asStack(umbrella))).rejects.toThrow();
  });

  it("f) degrades to a clean in-band tool error when mcp is on but actAs is absent", async () => {
    const umbrella = await createUmbrella({ withActAs: false });
    const connected = await connectWithSdk(asStack(umbrella));
    try {
      const call = await connected.client.callTool({ name: "host_invoices_list", arguments: {} });
      // Not a cookie-authenticated success, not a JSON-RPC protocol error: an
      // in-band tool error naming the missing seam (04 §4 / 10-mcp §3).
      expect(call.isError).toBe(true);
      expect(textOf(call).toLowerCase()).toContain("isn't set up");
      expect(textOf(call)).not.toContain("inv_0003");
    } finally {
      await connected.close();
    }
  });
});

async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const host = req.headers.host ?? "127.0.0.1";
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const request = new Request(`http://${host}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(error instanceof Error ? error.message : "umbrella bridge failed");
  }
}
