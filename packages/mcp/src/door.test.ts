import type {
  AppDocument,
  AuditEvent,
  BlobStore,
  Guard,
  Principal,
  RecordQuery,
  RecordStore,
  StoreAdapter,
  ToolOutcome,
  ToolRegistry,
  VendoRecord,
} from "@vendoai/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpDoor, type AppsPort, type McpDoor } from "./index.js";

const BASE = "https://product.example/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-test-suite-1234567890";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMcpDoor routing and OAuth", () => {
  it("serves path-inserted discovery documents, both server-card paths, and JSON 404s", async () => {
    const harness = makeHarness();
    const prm = await harness.door.handler(new Request(
      "https://PRODUCT.example:443/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(await prm.json()).toEqual({
      resource: BASE,
      authorization_servers: [BASE],
      bearer_methods_supported: ["header"],
    });

    const as = await harness.door.handler(new Request(
      "https://product.example/.well-known/oauth-authorization-server/api/vendo/mcp",
    ));
    expect(await as.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });

    // Cold start: no authenticated MCP traffic has taught the card its mount
    // yet, so it advertises the conventional /mcp fallback.
    for (const path of ["/.well-known/mcp/server-card.json", "/.well-known/mcp-server-card"]) {
      const response = await harness.door.handler(new Request(`https://product.example${path}`));
      expect(await response.json()).toMatchObject({
        protocol_versions: ["2025-11-25"],
        transports: [{ type: "streamable-http", url: "https://product.example/mcp" }],
        authorization: {
          type: "oauth2",
          resource_metadata: "https://product.example/.well-known/oauth-protected-resource/mcp",
        },
      });
    }

    // After authenticated traffic at the real mount, the card advertises it.
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);
    await connected.client.listTools();
    const learned = await harness.door.handler(new Request("https://product.example/.well-known/mcp/server-card.json"));
    expect(await learned.json()).toMatchObject({
      transports: [{ type: "streamable-http", url: BASE }],
      authorization: {
        type: "oauth2",
        resource_metadata: "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
      },
    });
    await connected.client.close();

    // Without a configured mount the door cannot distinguish "wrong path" from
    // "the mount": any non-well-known path is treated as the MCP endpoint and
    // challenged. Authority still derives only from token↔resource binding.
    const missing = await harness.door.handler(new Request("https://product.example/not-the-mount"));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://product.example/.well-known/oauth-protected-resource/not-the-mount"',
    );
  });

  it("stray first requests to other paths cannot poison discovery or auth at the real mount", async () => {
    const harness = makeHarness();
    // A scanner probes an unrelated well-known suffix and a random path FIRST.
    await harness.door.handler(new Request("https://product.example/.well-known/oauth-protected-resource/evil"));
    await harness.door.handler(new Request("https://product.example/healthz"));

    // The real mount still discovers and challenges exactly as before.
    const prm = await harness.door.handler(new Request(
      "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(await prm.json()).toMatchObject({ resource: BASE });
    const challenge = await harness.door.handler(new Request(BASE, { method: "POST" }));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp"',
    );

    // And a token minted against the real mount authenticates there.
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);
    expect((await connected.client.listTools()).tools.length).toBeGreaterThan(0);
    await connected.client.close();
  });

  it("returns the exact RFC 9728 challenge for missing and invalid bearer tokens", async () => {
    const harness = makeHarness();
    const missing = await harness.door.handler(new Request(BASE, { method: "POST" }));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp"',
    );

    const invalid = await harness.door.handler(new Request(BASE, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    }));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp", error="invalid_token"',
    );
  });

  it("does DCR, exact redirect checks, PKCE, and resource binding on authorize and token", async () => {
    const harness = makeHarness();
    const registered = await register(harness.door);
    expect(registered.response.status).toBe(201);
    expect(registered.body).toMatchObject({
      client_id: expect.stringMatching(/^mcpc_[0-9a-f]{24}$/),
      client_name: "Test client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(harness.audits.at(-1)?.detail).toEqual({ clientId: registered.body.client_id, event: "register" });

    const badRedirect = await authorize(harness.door, registered.body.client_id, {
      redirect_uri: "https://client.example/other",
    });
    expect(badRedirect.status).toBe(400);
    expect(await badRedirect.json()).toMatchObject({ error: "invalid_request" });

    const wrongResource = await authorize(harness.door, registered.body.client_id, {
      resource: "https://other.example/mcp",
      state: "state-1",
    });
    expect(wrongResource.status).toBe(302);
    expect(new URL(wrongResource.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    expect(new URL(wrongResource.headers.get("location")!).searchParams.get("state")).toBe("state-1");

    const auth = await authorize(harness.door, registered.body.client_id);
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;

    const badPkce = await exchange(harness.door, {
      code,
      client_id: registered.body.client_id,
      code_verifier: "wrong-verifier",
    });
    expect(badPkce.status).toBe(400);
    expect(await badPkce.json()).toMatchObject({ error: "invalid_grant" });

    const badTokenResource = await exchange(harness.door, {
      code,
      client_id: registered.body.client_id,
      code_verifier: VERIFIER,
      resource: "https://other.example/mcp",
    });
    expect(await badTokenResource.json()).toMatchObject({ error: "invalid_target" });

    const token = await exchange(harness.door, {
      code,
      client_id: registered.body.client_id,
      code_verifier: VERIFIER,
      resource: `${BASE}/`,
    });
    expect(token.status).toBe(200);
    const body = await token.json() as TokenResponse;
    expect(body.access_token).toMatch(/^vmat_[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).toMatch(/^vmrt_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read write" });
    expect(Object.keys(body).sort()).toEqual([
      "access_token", "expires_in", "refresh_token", "scope", "token_type",
    ]);
    expect(harness.audits.at(-1)?.detail).toEqual({ clientId: registered.body.client_id, event: "issue" });

    const grants = harness.store.rows("vendo_mcp_grants");
    expect(JSON.stringify(grants)).not.toContain(body.access_token);
    expect(JSON.stringify(grants)).not.toContain(body.refresh_token);
    expect(JSON.stringify(grants)).not.toContain(code);
  });

  it("rejects wrong-resource bearer tokens and rotates refresh tokens with reuse revocation", async () => {
    const harness = makeHarness();
    const client = await register(harness.door);
    const first = await issue(harness.door, client.body.client_id);

    const wrongDoor = makeHarness({ store: harness.store });
    const wrongResource = await wrongDoor.door.handler(new Request("https://product.example/other-mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${first.access_token}` },
    }));
    expect(wrongResource.status).toBe(401);

    const rotatedResponse = await refresh(harness.door, first.refresh_token, client.body.client_id);
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as TokenResponse;
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    expect(harness.audits.at(-1)?.detail).toEqual({ clientId: client.body.client_id, event: "refresh" });

    const reuse = await refresh(harness.door, first.refresh_token, client.body.client_id);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
    expect(harness.audits.at(-1)?.detail).toEqual({ clientId: client.body.client_id, event: "revoke" });

    const revoked = await harness.door.handler(new Request(BASE, {
      method: "POST",
      headers: { authorization: `Bearer ${rotated.access_token}` },
    }));
    expect(revoked.status).toBe(401);
  });

  it("resolves HTTPS Client ID Metadata Documents without redirects", async () => {
    const harness = makeHarness();
    const clientId = "https://client.example/metadata.json";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return new Response(JSON.stringify({
        client_id: clientId,
        client_name: "Metadata client",
        redirect_uris: [REDIRECT],
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await authorize(harness.door, clientId);
    expect(response.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(harness.authorizeContexts).toEqual([{ clientName: "Metadata client", scopes: ["read", "write"] }]);
  });
});

describe("createMcpDoor MCP protocol", () => {
  it("uses the real SDK for descriptors and all in-band outcome mappings", async () => {
    let outcome: ToolOutcome = { status: "ok", output: { answer: 42 } };
    const harness = makeHarness({ getOutcome: () => outcome });
    const clientRegistration = await register(harness.door);
    const tokens = await issue(harness.door, clientRegistration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    const listed = await connected.client.listTools();
    expect(listed.tools).toEqual([{
      name: "host_lookup",
      description: "Look something up",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }]);

    const ok = await connected.client.callTool({ name: "host_lookup", arguments: { query: "x" } });
    expect(ok).toMatchObject({
      content: [{ type: "text", text: '{"answer":42}' }],
      structuredContent: { answer: 42 },
    });
    expect(harness.executions[0]?.ctx).toMatchObject({
      principal: { kind: "user", subject: "user_1" },
      venue: "mcp",
      presence: "present",
      sessionId: expect.stringMatching(/^mcps_/),
    });
    expect(harness.executions[0]?.id).toMatch(/^mctc_/);

    outcome = { status: "error", error: { code: "upstream", message: "failed" } };
    expect(await connected.client.callTool({ name: "host_lookup", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: "upstream: failed" }],
    });

    outcome = { status: "pending-approval", approvalId: "apr_waiting" };
    const pending = await connected.client.callTool({ name: "host_lookup", arguments: {} });
    expect(pending.isError).toBe(true);
    expect(textOf(pending)).toContain("apr_waiting");
    expect(textOf(pending)).toContain("resolve it there, then retry");

    outcome = { status: "blocked", reason: "MCP access is disabled" };
    expect(await connected.client.callTool({ name: "host_lookup", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: "MCP access is disabled" }],
    });

    expect(await connected.client.callTool({ name: "unknown_tool", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: "not-found: Tool unknown_tool was not found" }],
    });
    const sessionId = connected.transport.sessionId!;
    await connected.transport.terminateSession();
    expect((await harness.door.handler(mcpRequest(tokens.access_token, sessionId))).status).toBe(404);
    await connected.client.close();
  });

  it("kills a subject's live session when principal resolution returns null", async () => {
    let principal: Principal | null = { kind: "user", subject: "user_1" };
    const harness = makeHarness({ principal: () => principal });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);
    await connected.client.listTools();
    const sessionId = connected.transport.sessionId!;

    principal = null;
    const revoked = await harness.door.handler(mcpRequest(tokens.access_token, sessionId));
    expect(revoked.status).toBe(401);
    expect(harness.audits.at(-1)?.detail).toEqual({ clientId: registration.body.client_id, event: "revoke" });

    const afterKill = await harness.door.handler(mcpRequest(tokens.access_token, sessionId));
    expect(afterKill.status).toBe(404);
    expect(await afterKill.json()).toMatchObject({ error: { message: "Session not found" } });
  });

  it("adds apps tools metadata and serves the static MCP Apps resource", async () => {
    const app: AppDocument = {
      format: "vendo/app@1",
      id: "app_1",
      name: "Dashboard",
      tree: { formatVersion: "vendo-genui/v1", root: "root", nodes: [] },
    };
    const apps: AppsPort = {
      async list() { return [app]; },
      async open() { return { kind: "tree", payload: app.tree! }; },
      async call(_appId, _ref, args) { return { received: args }; },
    };
    const harness = makeHarness({ apps });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    expect(connected.client.getServerCapabilities()?.extensions).toEqual({
      "io.modelcontextprotocol/ui": {},
    });

    const listed = await connected.client.listTools();
    const open = listed.tools.find((tool) => tool.name === "vendo_apps_open")!;
    const call = listed.tools.find((tool) => tool.name === "vendo_apps_call")!;
    expect(open._meta).toEqual({
      ui: { resourceUri: "ui://vendo/tree-shim.html" },
      "ui/resourceUri": "ui://vendo/tree-shim.html",
    });
    expect(call._meta).toEqual(open._meta);

    const opened = await connected.client.callTool({ name: "vendo_apps_open", arguments: { appId: "app_1" } });
    expect(opened.structuredContent).toEqual(app.tree);
    const called = await connected.client.callTool({
      name: "vendo_apps_call",
      arguments: { appId: "app_1", ref: "host_lookup", args: { query: "x" } },
    });
    expect(called.structuredContent).toEqual({ received: { query: "x" } });

    const resources = await connected.client.listResources();
    expect(resources.resources).toEqual([expect.objectContaining({
      uri: "ui://vendo/tree-shim.html",
      mimeType: "text/html;profile=mcp-app",
    })]);
    const resource = await connected.client.readResource({ uri: "ui://vendo/tree-shim.html" });
    expect(resource.contents[0]).toMatchObject({
      uri: "ui://vendo/tree-shim.html",
      mimeType: "text/html;profile=mcp-app",
      text: expect.stringContaining("<!doctype html>"),
    });
    await connected.client.close();
  });

  it("keeps the bound registry verbatim when it already carries a vendo_apps_* tool", async () => {
    const apps: AppsPort = {
      async list() { return []; },
      async open() { return { kind: "http", url: "https://app.example" }; },
      async call() { return null; },
    };
    const harness = makeHarness({
      apps,
      extraDescriptors: [{
        name: "vendo_apps_open",
        description: "Registry-owned apps open (agentTools via the umbrella)",
        inputSchema: { type: "object" },
        risk: "read",
      }],
    });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    const listed = await connected.client.listTools();
    const opens = listed.tools.filter((tool) => tool.name === "vendo_apps_open");
    // Exactly one listing — the registry's, verbatim (no door _meta, no dupes);
    // the door still adds its non-colliding ride-along tools.
    expect(opens).toEqual([{
      name: "vendo_apps_open",
      description: "Registry-owned apps open (agentTools via the umbrella)",
      inputSchema: { type: "object" },
    }]);
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["vendo_apps_list", "vendo_apps_call"]),
    );

    // Execution routes through the registry, not the AppsPort.
    const before = harness.executions.length;
    const result = await connected.client.callTool({ name: "vendo_apps_open", arguments: {} });
    expect(result).toMatchObject({ structuredContent: { answer: 42 } });
    expect(harness.executions.length).toBe(before + 1);
    await connected.client.close();
  });
});

interface HarnessOptions {
  store?: MemoryStore;
  getOutcome?: () => ToolOutcome;
  principal?: () => Principal | null;
  apps?: AppsPort;
  extraDescriptors?: Awaited<ReturnType<ToolRegistry["descriptors"]>>;
}

function makeHarness(options: HarnessOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const audits: AuditEvent[] = [];
  const authorizeContexts: Array<{ clientName: string; scopes: string[] }> = [];
  const executions: Array<{ id: string; ctx: Parameters<ToolRegistry["execute"]>[1] }> = [];
  const guard: Guard = {
    async check() { return { action: "run", decidedBy: "default" }; },
    async report(event) { audits.push(event); },
    async directions() { return []; },
    onApprovalDecision() { return () => undefined; },
  };
  const tools: ToolRegistry = {
    async descriptors() {
      return [{
        name: "host_lookup",
        description: "Look something up",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        risk: "read",
      }, ...(options.extraDescriptors ?? [])];
    },
    async execute(call, ctx) {
      executions.push({ id: call.id, ctx });
      return options.getOutcome?.() ?? { status: "ok", output: { answer: 42 } };
    },
  };
  const door = createMcpDoor({
    tools,
    guard,
    store,
    apps: options.apps,
    oauth: {
      async authorize(_req, ctx) {
        authorizeContexts.push(ctx);
        return { subject: "user_1" };
      },
      async principal() {
        return options.principal ? options.principal() : { kind: "user", subject: "user_1" };
      },
    },
  });
  return { door, store, audits, authorizeContexts, executions };
}

async function register(door: McpDoor) {
  const response = await door.handler(new Request(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test client", redirect_uris: [REDIRECT], scope: "read write" }),
  }));
  return { response, body: await response.clone().json() as { client_id: string } & Record<string, unknown> };
}

async function authorize(door: McpDoor, clientId: string, overrides: Record<string, string> = {}) {
  const challenge = await pkceChallenge(VERIFIER);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "read write",
    resource: BASE,
    ...overrides,
  });
  return door.handler(new Request(`${BASE}/authorize?${params}`));
}

async function exchange(door: McpDoor, values: Record<string, string>) {
  return door.handler(new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      ...values,
    }),
  }));
}

async function issue(door: McpDoor, clientId: string): Promise<TokenResponse> {
  const auth = await authorize(door, clientId);
  const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
  const response = await exchange(door, { code, client_id: clientId, code_verifier: VERIFIER, resource: BASE });
  expect(response.status).toBe(200);
  return response.json() as Promise<TokenResponse>;
}

async function refresh(door: McpDoor, refreshToken: string, clientId: string) {
  return door.handler(new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: BASE,
    }),
  }));
}

async function connect(door: McpDoor, accessToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      return door.handler(new Request(input, { ...init, headers }));
    },
  });
  const client = new Client({ name: "door-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function mcpRequest(accessToken: string, sessionId: string) {
  return new Request(BASE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
  });
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return Buffer.from(digest).toString("base64url");
}

function textOf(result: unknown): string {
  return ((result as { content: unknown[] }).content[0] as { text: string }).text;
}

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

class MemoryStore implements StoreAdapter {
  readonly #collections = new Map<string, Map<string, VendoRecord>>();

  rows(collection: string): VendoRecord[] {
    return [...(this.#collections.get(collection)?.values() ?? [])];
  }

  records(collection: string): RecordStore {
    const rows = this.#collections.get(collection) ?? new Map<string, VendoRecord>();
    this.#collections.set(collection, rows);
    return {
      async get(id) { return rows.get(id) ?? null; },
      async put(record) {
        const prior = rows.get(record.id);
        const now = new Date().toISOString();
        const stored: VendoRecord = {
          id: record.id,
          data: structuredClone(record.data),
          ...(record.refs === undefined ? {} : { refs: { ...record.refs } }),
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        rows.set(stored.id, stored);
        return stored;
      },
      async delete(id) { rows.delete(id); },
      async list(query?: RecordQuery) {
        const records = [...rows.values()].filter((record) => {
          if (query?.ids && !query.ids.includes(record.id)) return false;
          return Object.entries(query?.refs ?? {}).every(([key, value]) => record.refs?.[key] === value);
        });
        return { records: records.slice(0, query?.limit) };
      },
    };
  }

  blobs(): BlobStore {
    return {
      async put() { return undefined; },
      async get() { return null; },
      async delete() { return undefined; },
      async list() { return []; },
    };
  }

  async ensureSchema(): Promise<void> {
    return undefined;
  }
}
