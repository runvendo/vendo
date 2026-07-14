import {
  canonicalJson,
  type AppDocument,
  type AuditEvent,
  type BlobStore,
  type Guard,
  type Principal,
  type RecordQuery,
  type RecordStore,
  type StoreAdapter,
  type ToolOutcome,
  type ToolRegistry,
  type VendoRecord,
} from "@vendoai/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpDoorWithState } from "./door.js";
import { createMcpDoor, type AppsPort, type McpDoor } from "./index.js";
import type {
  McpDoorState,
  McpStateSession,
  ReplayStateOptions,
  SessionStateRecord,
} from "./state.js";

const BASE = "https://product.example/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-test-suite-1234567890";

// The door resolves CIMD hostnames and rejects private answers (SSRF DNS-rebind
// defense). `.example` is a reserved non-resolving TLD, so mock the resolver;
// individual tests point it at a private address to exercise the guard.
const dnsMock = vi.hoisted(() => ({ addresses: [{ address: "93.184.216.34" }] as Array<{ address: string }> }));
vi.mock("node:dns/promises", () => ({ lookup: async () => dnsMock.addresses }));

afterEach(() => {
  vi.unstubAllGlobals();
  dnsMock.addresses = [{ address: "93.184.216.34" }];
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

  it("advertises a configured mount on the cold server card, before any traffic (FIX C)", async () => {
    const harness = makeHarness({ mount: "/api/vendo/mcp" });
    // Cold start: no authenticated MCP request has arrived. A configured mount is
    // authoritative, so the card advertises /api/vendo/mcp — not the /mcp fallback
    // the unconfigured door would use.
    for (const path of ["/.well-known/mcp/server-card.json", "/.well-known/mcp-server-card"]) {
      const cold = await harness.door.handler(new Request(`https://product.example${path}`));
      expect(await cold.json()).toMatchObject({
        transports: [{ type: "streamable-http", url: BASE }],
        authorization: {
          type: "oauth2",
          resource_metadata: "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
        },
      });
    }

    // Authenticated traffic does not move a configured mount.
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);
    await connected.client.listTools();
    const after = await harness.door.handler(new Request("https://product.example/.well-known/mcp/server-card.json"));
    expect(await after.json()).toMatchObject({ transports: [{ type: "streamable-http", url: BASE }] });
    await connected.client.close();
  });

  it("refuses CIMD client ids pointing at non-public hosts without fetching them", async () => {
    const harness = makeHarness();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const clientId of [
      "https://127.0.0.1/client.json",
      "https://10.0.0.8/client.json",
      "https://[::1]/client.json",
      "https://localhost/client.json",
      "https://intranet/client.json",
      "https://admin.internal/client.json",
    ]) {
      const response = await authorize(harness.door, clientId);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a CIMD host that resolves to a private address (DNS-rebind defense)", async () => {
    const harness = makeHarness();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // A syntactically-public wildcard-DNS name whose A record is the cloud
    // metadata IP — the case a purely syntactic check would miss.
    dnsMock.addresses = [{ address: "169.254.169.254" }];
    const response = await authorize(harness.door, "https://169-254-169-254.sslip.io/client.json");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
    expect(fetchSpy).not.toHaveBeenCalled();
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

    // A presented code is consumed (single-use, see the dedicated test below),
    // so each failed exchange below needs its own freshly minted code.
    const freshCode = async (): Promise<string> => {
      const auth = await authorize(harness.door, registered.body.client_id);
      return new URL(auth.headers.get("location")!).searchParams.get("code")!;
    };

    const badPkce = await exchange(harness.door, {
      code: await freshCode(),
      client_id: registered.body.client_id,
      code_verifier: "wrong-verifier",
    });
    expect(badPkce.status).toBe(400);
    expect(await badPkce.json()).toMatchObject({ error: "invalid_grant" });

    const badTokenResource = await exchange(harness.door, {
      code: await freshCode(),
      client_id: registered.body.client_id,
      code_verifier: VERIFIER,
      resource: "https://other.example/mcp",
    });
    expect(await badTokenResource.json()).toMatchObject({ error: "invalid_target" });

    const token = await exchange(harness.door, {
      code: await freshCode(),
      client_id: registered.body.client_id,
      code_verifier: VERIFIER,
      // A trailing slash is the same canonical resource — binding is compared
      // canonically, not byte-wise.
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

    // Nothing token-shaped is stored in the clear — codes included (an unredeemed
    // code is live state, so mint one and leave it pending for this assertion).
    const pendingCode = await freshCode();
    const grants = harness.store.rows("vendo_mcp_grants");
    expect(JSON.stringify(grants)).not.toContain(body.access_token);
    expect(JSON.stringify(grants)).not.toContain(body.refresh_token);
    expect(JSON.stringify(grants)).not.toContain(pendingCode);
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

  it("does not fork on concurrent refresh of the same token (atomic claim)", async () => {
    const harness = makeHarness();
    const client = await register(harness.door);
    const first = await issue(harness.door, client.body.client_id);

    // Two simultaneous rotations of the same refresh token: the store claim
    // admits exactly one and the other sees reuse of the already-rotated grant.
    const [a, b] = await Promise.all([
      refresh(harness.door, first.refresh_token, client.body.client_id),
      refresh(harness.door, first.refresh_token, client.body.client_id),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const winner = a.status === 200 ? a : b;
    const rotated = await winner.json() as TokenResponse;
    // Reuse of the original now revokes the chain, including the one successor.
    const reuse = await refresh(harness.door, first.refresh_token, client.body.client_id);
    expect(reuse.status).toBe(400);
    const successorReuse = await refresh(harness.door, rotated.refresh_token, client.body.client_id);
    expect(successorReuse.status).toBe(400);
  });

  it("consumes an authorization code the moment it is presented, even on PKCE failure", async () => {
    const harness = makeHarness();
    const registration = await register(harness.door);
    const auth = await authorize(harness.door, registration.body.client_id);
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;

    const wrongVerifier = await exchange(harness.door, {
      code,
      client_id: registration.body.client_id,
      code_verifier: `${VERIFIER.slice(0, -1)}X`,
      resource: BASE,
    });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({ error: "invalid_grant" });

    // The stolen code is dead: the correct verifier no longer redeems it.
    const retry = await exchange(harness.door, {
      code,
      client_id: registration.body.client_id,
      code_verifier: VERIFIER,
      resource: BASE,
    });
    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("sweeps sessions abandoned past the access-token lifetime", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const registration = await register(harness.door);
      const tokens = await issue(harness.door, registration.body.client_id);
      const connected = await connect(harness.door, tokens.access_token);
      await connected.client.listTools();
      const sessionId = connected.transport.sessionId!;

      // The client abandons the session; its token outlives it by a minute.
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      const revived = await issue(harness.door, registration.body.client_id);
      const afterSweep = await harness.door.handler(mcpRequest(revived.access_token, sessionId));
      expect(afterSweep.status).toBe(404);
      expect(await afterSweep.json()).toMatchObject({ error: { message: "Session not found" } });
    } finally {
      vi.useRealTimers();
    }
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
    // 10-mcp §3: the door projects the authenticated OAuth grant's consent onto
    // every RunContext it mints — the evidence actions uses to authenticate host
    // execution via actAs. A tools/call re-uses the session (the existing-session
    // refresh path), which must carry the consent just like the fresh mint does.
    expect((harness.executions[0]?.ctx as { mcpConsent?: unknown }).mcpConsent).toEqual({
      clientId: clientRegistration.body.client_id,
      scopes: ["read", "write"],
    });

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

  it("never serves a session to an ephemeral principal", async () => {
    const harness = makeHarness({ principal: () => ({ kind: "user", subject: "user_1", ephemeral: true }) });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const response = await harness.door.handler(mcpRequest(tokens.access_token));
    expect(response.status).toBe(401);
  });

  it("stops refresh rotation once the subject is revoked, and revokes the chain", async () => {
    let principal: Principal | null = { kind: "user", subject: "user_1" };
    const harness = makeHarness({ principal: () => principal });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);

    principal = null;
    const refreshed = await harness.door.handler(new Request(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: registration.body.client_id,
      }),
    }));
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    expect(harness.audits.at(-1)?.detail).toEqual({ clientId: registration.body.client_id, event: "revoke" });
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
    const list = listed.tools.find((tool) => tool.name === "vendo_apps_list")!;
    expect(open._meta).toEqual({
      ui: { resourceUri: "ui://vendo/tree-shim.html" },
      "ui/resourceUri": "ui://vendo/tree-shim.html",
    });
    expect(call._meta).toEqual(open._meta);
    expect(list._meta).toEqual(open._meta);

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

  it("does not send already-resolved tree queries back to the MCP shim", async () => {
    const payload = {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [],
      data: { total: 42 },
      queries: [{ path: "/total", tool: "host_total" }],
    };
    const apps: AppsPort = {
      async list() { return []; },
      async open() { return { kind: "tree", payload }; },
      async call() { return null; },
    };
    const harness = makeHarness({ apps });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    const opened = await connected.client.callTool({ name: "vendo_apps_open", arguments: { appId: "app_1" } });
    expect(opened.structuredContent).toEqual({
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [],
      data: { total: 42 },
    });
    expect(payload.queries).toEqual([{ path: "/total", tool: "host_total" }]);
    await connected.client.close();
  });

  it("gives vendo_apps_* door tools full guard treatment with venue mcp", async () => {
    const apps: AppsPort = {
      async list() { return []; },
      async open() { return { kind: "tree", payload: { formatVersion: "vendo-genui/v1" } }; },
      async call() { return { done: true }; },
    };
    const decisions: Array<{ tool: string; venue: string; risk: string }> = [];
    let action: "run" | "block" = "run";
    const harness = makeHarness({
      apps,
      check: async (call, descriptor, ctx) => {
        decisions.push({ tool: call.tool, venue: ctx.venue, risk: descriptor.risk });
        return action === "run"
          ? { action: "run", decidedBy: "default" }
          : { action: "block", reason: "MCP apps are disabled", decidedBy: "rule" };
      },
    });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    await connected.client.callTool({
      name: "vendo_apps_call",
      arguments: { appId: "app_1", ref: "host_write", args: {} },
    });
    expect(decisions).toEqual([{ tool: "vendo_apps_call", venue: "mcp", risk: "write" }]);
    const audit = harness.audits.at(-1)!;
    expect(audit).toMatchObject({
      kind: "tool-call",
      tool: "vendo_apps_call",
      venue: "mcp",
      presence: "present",
      outcome: "ok",
      decidedBy: "default",
    });
    expect(audit.inputPreview).toContain("vendo_apps_call");

    action = "block";
    const blocked = await connected.client.callTool({ name: "vendo_apps_open", arguments: { appId: "app_1" } });
    expect(blocked).toMatchObject({ isError: true, content: [{ text: "MCP apps are disabled" }] });
    expect(harness.audits.at(-1)).toMatchObject({
      kind: "tool-call",
      tool: "vendo_apps_open",
      venue: "mcp",
      outcome: "blocked",
      decidedBy: "rule",
    });
    await connected.client.close();
  });

  it("keeps a registry-owned vendo_apps_* verbatim but attaches the shim _meta and renders its payload (FIX E)", async () => {
    const treePayload = {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [],
      data: { via: "registry" },
      queries: [{ path: "/via", tool: "host_source" }],
    };
    const apps: AppsPort = {
      async list() { return []; },
      async open() { return { kind: "http", url: "https://app.example" }; },
      async call() { return null; },
    };
    const harness = makeHarness({
      apps,
      // The registry (apps.agentTools via the umbrella) owns vendo_apps_open and
      // returns an OpenSurface envelope — exactly what the door must unwrap.
      getOutcome: () => ({ status: "ok", output: { kind: "tree", payload: treePayload } }),
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
    // Exactly one listing — the registry's descriptor VERBATIM (name/description/
    // inputSchema untouched), no dupes — but now carrying the door's shim _meta so
    // MCP Apps clients preload the renderer (FIX E).
    expect(opens).toEqual([{
      name: "vendo_apps_open",
      description: "Registry-owned apps open (agentTools via the umbrella)",
      inputSchema: { type: "object" },
      _meta: {
        ui: { resourceUri: "ui://vendo/tree-shim.html" },
        "ui/resourceUri": "ui://vendo/tree-shim.html",
      },
    }]);
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["vendo_apps_list", "vendo_apps_call"]),
    );

    // Execution routes through the registry (one guard decision), not the
    // AppsPort — and the door unwraps its OpenSurface into a bare, shim-renderable
    // format-tagged UIPayload (core §8), not the {kind,payload} envelope. The
    // registry's AppsRuntime.open already resolved `queries` into `data`, so the
    // MCP projection removes those declarations rather than calling them twice.
    const before = harness.executions.length;
    const result = await connected.client.callTool({ name: "vendo_apps_open", arguments: {} });
    expect(result.structuredContent).toEqual({
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [],
      data: { via: "registry" },
    });
    expect(treePayload.queries).toEqual([{ path: "/via", tool: "host_source" }]);
    expect(harness.executions.length).toBe(before + 1);
    await connected.client.close();
  });

  it("reuses a parked call id for identical retries and clears it on resolution (FIX B)", async () => {
    let outcome: ToolOutcome = { status: "pending-approval", approvalId: "apr_1" };
    const harness = makeHarness({ getOutcome: () => outcome });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    const args = { query: "same" };
    // A destructive-shaped call parks; the retry of the IDENTICAL call must carry
    // the same ToolCall id so guard's single-use approval replay (which pins
    // call.id) can authorize it — a fresh id would silently re-park.
    await connected.client.callTool({ name: "host_lookup", arguments: args });
    await connected.client.callTool({ name: "host_lookup", arguments: args });
    const parkedId = harness.executions[0]!.id;
    expect(parkedId).toMatch(/^mctc_/);
    expect(harness.executions[1]!.id).toBe(parkedId);

    // A DISTINCT call (different args) gets its own unique id — ids stay unique
    // per distinct call (01-core).
    await connected.client.callTool({ name: "host_lookup", arguments: { query: "other" } });
    expect(harness.executions[2]!.id).not.toBe(parkedId);

    // The approval resolves (run): the parked id is reused one last time, then cleared.
    outcome = { status: "ok", output: { answer: 1 } };
    await connected.client.callTool({ name: "host_lookup", arguments: args });
    expect(harness.executions[3]!.id).toBe(parkedId);

    // The one-off approval is spent: a later identical call mints a fresh id and
    // would park anew.
    outcome = { status: "pending-approval", approvalId: "apr_2" };
    await connected.client.callTool({ name: "host_lookup", arguments: args });
    expect(harness.executions[4]!.id).not.toBe(parkedId);
    await connected.client.close();
  });

  it("routes session lifetime and approval replay through a pluggable state seam", async () => {
    let outcome: ToolOutcome = { status: "pending-approval", approvalId: "apr_pluggable" };
    const state = new TestMcpDoorState();
    const harness = makeHarness({ state, getOutcome: () => outcome });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    await connected.client.listTools();
    const sessionId = connected.transport.sessionId!;
    const args = { query: "through-the-seam" };
    await connected.client.callTool({ name: "host_lookup", arguments: args });
    await connected.client.callTool({ name: "host_lookup", arguments: args });
    expect(harness.executions[1]!.id).toBe(harness.executions[0]!.id);
    expect(state.operations).toEqual(expect.arrayContaining([
      `session:set:${sessionId}`,
      `session:get:${sessionId}`,
      `session:touch:${sessionId}`,
      `replay:get:${sessionId}`,
      `replay:set:${sessionId}`,
    ]));

    outcome = { status: "ok", output: { answer: 1 } };
    await connected.client.callTool({ name: "host_lookup", arguments: args });
    expect(state.operations).toContain(`replay:delete:${sessionId}`);

    await connected.transport.terminateSession();
    expect(state.operations).toContain(`session:delete:${sessionId}`);
    expect((await harness.door.handler(mcpRequest(tokens.access_token, sessionId))).status).toBe(404);
    await connected.client.close();
  });

  it("refuses subject B's bearer presented with subject A's session id (FIX G)", async () => {
    let subject = "user_a";
    const harness = makeHarness({ authorizeSubject: () => subject });
    const registration = await register(harness.door);

    // Subject A establishes a live session.
    const tokensA = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokensA.access_token);
    await connected.client.listTools();
    const sessionA = connected.transport.sessionId!;

    // Subject B authenticates and gets a valid bearer of their own.
    subject = "user_b";
    const tokensB = await issue(harness.door, registration.body.client_id);

    // B's valid bearer carrying A's session id → unknown-session, never executes.
    const before = harness.executions.length;
    const crossed = await harness.door.handler(mcpRequest(tokensB.access_token, sessionA));
    expect(crossed.status).toBe(404);
    expect(await crossed.json()).toMatchObject({ error: { message: "Session not found" } });
    expect(harness.executions.length).toBe(before);
    await connected.client.close();
  });
});

interface HarnessOptions {
  store?: MemoryStore;
  state?: McpDoorState;
  getOutcome?: () => ToolOutcome;
  principal?: () => Principal | null;
  apps?: AppsPort;
  extraDescriptors?: Awaited<ReturnType<ToolRegistry["descriptors"]>>;
  check?: Guard["check"];
  mount?: string;
  /** The subject the OAuth authorize step returns (defaults "user_1"); a fn lets
   * a test mint tokens for two different subjects against one door (FIX G). */
  authorizeSubject?: () => string;
}

function makeHarness(options: HarnessOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const audits: AuditEvent[] = [];
  const authorizeContexts: Array<{ clientName: string; scopes: string[] }> = [];
  const executions: Array<{ id: string; ctx: Parameters<ToolRegistry["execute"]>[1] }> = [];
  const guard: Guard = {
    check: options.check ?? (async () => ({ action: "run", decidedBy: "default" })),
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
  const config = {
    tools,
    guard,
    store,
    apps: options.apps,
    ...(options.mount === undefined ? {} : { mount: options.mount }),
    oauth: {
      async authorize(_req, ctx) {
        authorizeContexts.push(ctx);
        return { subject: options.authorizeSubject ? options.authorizeSubject() : "user_1" };
      },
      async principal() {
        return options.principal ? options.principal() : { kind: "user", subject: "user_1" };
      },
    },
  };
  const door = options.state === undefined
    ? createMcpDoor(config)
    : createMcpDoorWithState(config, options.state);
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

function mcpRequest(accessToken: string, sessionId?: string) {
  return new Request(BASE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      ...(sessionId === undefined
        ? { method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }
        : { method: "tools/list", params: {} }),
    }),
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

class TestMcpDoorState implements McpDoorState {
  readonly operations: string[] = [];
  readonly #sessions = new Map<string, SessionStateRecord>();
  readonly #replay = new Map<
    string,
    Map<string, { callId: string; subject: string; expiresAt: number }>
  >();

  async getSession(sessionId: string): Promise<McpStateSession | null> {
    this.operations.push(`session:get:${sessionId}`);
    return this.#sessions.get(sessionId)?.session ?? null;
  }

  async setSession(record: SessionStateRecord): Promise<void> {
    this.operations.push(`session:set:${record.sessionId}`);
    this.#sessions.set(record.sessionId, record);
  }

  async touchSession(sessionId: string, expiresAt: number): Promise<void> {
    this.operations.push(`session:touch:${sessionId}`);
    const record = this.#sessions.get(sessionId);
    if (record) record.expiresAt = expiresAt;
    for (const replay of this.#replay.get(record?.session.replayScope ?? sessionId)?.values() ?? []) {
      replay.expiresAt = expiresAt;
    }
  }

  async deleteSession(sessionId: string): Promise<McpStateSession | null> {
    this.operations.push(`session:delete:${sessionId}`);
    const record = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    if (record) this.#replay.delete(record.session.replayScope);
    return record?.session ?? null;
  }

  async deleteSessionsBySubject(subject: string): Promise<McpStateSession[]> {
    this.operations.push(`session:delete-subject:${subject}`);
    const sessions: McpStateSession[] = [];
    for (const [sessionId, record] of this.#sessions) {
      if (record.subject !== subject) continue;
      sessions.push(record.session);
      this.#sessions.delete(sessionId);
      this.#replay.delete(record.session.replayScope);
    }
    for (const [scope, entries] of this.#replay) {
      for (const [key, replay] of entries) {
        if (replay.subject === subject) entries.delete(key);
      }
      if (entries.size === 0) this.#replay.delete(scope);
    }
    return sessions;
  }

  async sweepExpiredSessions(now: number): Promise<McpStateSession[]> {
    this.operations.push("session:sweep");
    const sessions: McpStateSession[] = [];
    for (const [sessionId, record] of this.#sessions) {
      if (record.expiresAt > now) continue;
      sessions.push(record.session);
      this.#sessions.delete(sessionId);
      this.#replay.delete(record.session.replayScope);
    }
    return sessions;
  }

  async getReplay(scope: string, key: string, now: number): Promise<string | null> {
    this.operations.push(`replay:get:${scope}`);
    const replay = this.#replay.get(scope)?.get(key);
    if (replay === undefined) return null;
    if (replay.expiresAt > now) return replay.callId;
    this.#replay.get(scope)?.delete(key);
    return null;
  }

  async setReplay(
    scope: string,
    key: string,
    callId: string,
    options: ReplayStateOptions,
  ): Promise<void> {
    this.operations.push(`replay:set:${scope}`);
    const entries = this.#replay.get(scope) ?? new Map<
      string,
      { callId: string; subject: string; expiresAt: number }
    >();
    if (!entries.has(key) && entries.size >= options.capacity) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(key, {
      callId,
      subject: options.subject,
      expiresAt: options.expiresAt,
    });
    this.#replay.set(scope, entries);
  }

  async deleteReplay(scope: string, key: string): Promise<void> {
    this.operations.push(`replay:delete:${scope}`);
    this.#replay.get(scope)?.delete(key);
  }
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
      async claim(expected, replacement) {
        const current = rows.get(expected.id);
        if (
          !current
          || canonicalJson(current.data) !== canonicalJson(expected.data)
          || canonicalJson(current.refs ?? null) !== canonicalJson(expected.refs ?? null)
        ) return false;
        if (replacement === undefined) {
          rows.delete(expected.id);
        } else {
          const now = new Date().toISOString();
          rows.set(expected.id, {
            id: expected.id,
            data: structuredClone(replacement.data),
            ...(replacement.refs === undefined ? {} : { refs: { ...replacement.refs } }),
            createdAt: current.createdAt,
            updatedAt: now,
          });
        }
        return true;
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
