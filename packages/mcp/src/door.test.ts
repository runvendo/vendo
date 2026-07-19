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
  type VendoTheme,
  type VendoRecord,
} from "@vendoai/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type KeyLike } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpDoorWithState } from "./door.js";
import {
  createMcpDoor,
  type AppsPort,
  type HostOAuthAdapter,
  type McpDoor,
} from "./index.js";
import type {
  McpDoorState,
  McpStateSession,
  ReplayStateOptions,
  SessionStateRecord,
} from "./state.js";

const BASE = "https://product.example/api/vendo/mcp";
const PROXIED_BASE = "http://door.internal:8787/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-test-suite-1234567890";
const CONSENT_THEME: VendoTheme = {
  colors: {
    background: "#101820",
    surface: "#18242f",
    text: "#f4f7fa",
    muted: "#aebbc7",
    accent: "#ffb81c",
    accentText: "#101820",
    danger: "#f35b66",
    border: "#405261",
  },
  typography: {
    fontFamily: "Inter, sans-serif",
    headingFamily: "Newsreader, serif",
    baseSize: "16px",
  },
  radius: { small: "4px", medium: "8px", large: "14px" },
  density: "compact",
  motion: "reduced",
};

const MAPLE_THEME: VendoTheme = {
  colors: {
    background: "#FBFBFA",
    surface: "#FFFFFF",
    text: "#111111",
    muted: "#908C85",
    accent: "#0A7CFF",
    accentText: "#FFFFFF",
    danger: "#B42318",
    border: "#E2E1DE",
  },
  typography: { fontFamily: "Maple Sans, system-ui, sans-serif", baseSize: "15px" },
  radius: { small: "6px", medium: "14px", large: "14px" },
  density: "comfortable",
  motion: "full",
};

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
      revocation_endpoint: `${BASE}/revoke`,
      registration_endpoint: `${BASE}/register`,
      scopes_supported: ["read", "write"],
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

  it("returns an empty 200 for an unknown token and ignores an unknown token type hint", async () => {
    const harness = makeHarness();
    const client = await register(harness.door);

    const response = await revoke(harness.door, "vmrt_unknown", client.body.client_id, "future_token_type");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(harness.audits.filter((event) => event.detail?.event === "revoke")).toEqual([]);
  });

  it("refuses a valid public client trying to revoke another client's token", async () => {
    const harness = makeHarness();
    const owner = await register(harness.door);
    const other = await register(harness.door);
    const tokens = await issue(harness.door, owner.body.client_id);

    const response = await revoke(harness.door, tokens.refresh_token, other.body.client_id, "refresh_token");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
    expect((await refresh(harness.door, tokens.refresh_token, owner.body.client_id)).status).toBe(200);
  });

  it("revokes one access token atomically without revoking its refresh grant", async () => {
    const harness = makeHarness();
    const client = await register(harness.door);
    const tokens = await issue(harness.door, client.body.client_id);

    const response = await revoke(harness.door, tokens.access_token, client.body.client_id, "access_token");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect((await harness.door.handler(mcpRequest(tokens.access_token))).status).toBe(401);
    expect((await refresh(harness.door, tokens.refresh_token, client.body.client_id)).status).toBe(200);
    expect(harness.audits.map((event) => event.detail)).toContainEqual({
      clientId: client.body.client_id,
      event: "revoke",
    });
  });

  it("revoking a refresh token kills its access tokens and rotated successors, but not another family", async () => {
    const harness = makeHarness();
    const client = await register(harness.door);
    const first = await issue(harness.door, client.body.client_id);
    const rotatedResponse = await refresh(harness.door, first.refresh_token, client.body.client_id);
    const rotated = await rotatedResponse.json() as TokenResponse;
    const independent = await issue(harness.door, client.body.client_id);

    // A wrong recognized hint is only an optimization. RFC 7009 requires the
    // server to continue across the other supported token type.
    const response = await revoke(harness.door, first.refresh_token, client.body.client_id, "access_token");

    expect(response.status).toBe(200);
    expect((await harness.door.handler(mcpRequest(first.access_token))).status).toBe(401);
    expect((await harness.door.handler(mcpRequest(rotated.access_token))).status).toBe(401);
    expect((await refresh(harness.door, rotated.refresh_token, client.body.client_id)).status).toBe(400);
    expect((await harness.door.handler(mcpRequest(independent.access_token))).status).toBe(200);

    const families = harness.store.rows("vendo_mcp_grants")
      .filter((row) => row.data.kind === "family")
      .map((row) => row.data.status)
      .sort();
    expect(families).toEqual(["active", "revoked"]);
  });

  it("lets the host revoke all families and live sessions for one subject/client", async () => {
    const harness = makeHarness();
    const clientA = await register(harness.door);
    const clientB = await register(harness.door);
    const firstA = await issue(harness.door, clientA.body.client_id);
    const secondA = await issue(harness.door, clientA.body.client_id);
    const tokensB = await issue(harness.door, clientB.body.client_id);
    const connectedA = await connect(harness.door, firstA.access_token);
    const oldSessionId = connectedA.transport.sessionId;
    expect(oldSessionId).toMatch(/^mcps_/);

    await harness.door.revokeClient("user_1", clientA.body.client_id);

    expect((await harness.door.handler(mcpRequest(firstA.access_token))).status).toBe(401);
    expect((await harness.door.handler(mcpRequest(secondA.access_token))).status).toBe(401);
    expect((await refresh(harness.door, firstA.refresh_token, clientA.body.client_id)).status).toBe(400);
    expect((await harness.door.handler(mcpRequest(tokensB.access_token))).status).toBe(200);

    // Revocation does not prohibit a later explicit re-authorization, but the
    // old live runtime was removed rather than left reusable.
    const reauthorizedA = await issue(harness.door, clientA.body.client_id);
    expect((await harness.door.handler(mcpRequest(reauthorizedA.access_token, oldSessionId))).status).toBe(404);
    expect(harness.audits.map((event) => event.detail)).toContainEqual({
      clientId: clientA.body.client_id,
      event: "revoke",
    });
    await connectedA.client.close().catch(() => undefined);
  });

  it("revokes a pre-family authorization code during a rolling deployment", async () => {
    const harness = makeHarness();
    const client = await register(harness.door);
    const code = "vmcd_pre_family_code";
    await harness.store.records("vendo_mcp_grants").put({
      id: "mcpg_pre_family_code",
      data: {
        kind: "code",
        subject: "user_1",
        clientId: client.body.client_id,
        resource: BASE,
        scopes: ["read", "write"],
        codeChallenge: await pkceChallenge(VERIFIER),
        redirectUri: REDIRECT,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      refs: { kind: "code", token_hash: await sha256Hex(code) },
    });

    await harness.door.revokeClient("user_1", client.body.client_id);

    const exchangeResponse = await exchange(harness.door, {
      code,
      client_id: client.body.client_id,
      code_verifier: VERIFIER,
      resource: BASE,
    });
    expect(exchangeResponse.status).toBe(400);
    expect(await exchangeResponse.json()).toMatchObject({ error: "invalid_grant" });
    expect(harness.store.rows("vendo_mcp_grants")[0]?.data.revokedAt).toEqual(expect.any(String));
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

  it("bounces a missing host session to login with an exact return-to, then renders consent", async () => {
    let subject: string | undefined;
    const sessionCalls: Array<{ url: string; returnTo: string }> = [];
    const harness = makeHarness({
      oauth: {
        async session(req, { returnTo }) {
          sessionCalls.push({ url: req.url, returnTo });
          if (!subject) {
            const login = new URL("https://product.example/login");
            login.searchParams.set("returnTo", returnTo);
            return Response.redirect(login);
          }
          return { subject };
        },
        async principal(resolvedSubject) {
          return { kind: "user", subject: resolvedSubject };
        },
      },
    });
    const registered = await register(harness.door);
    const initial = await authorize(harness.door, registered.body.client_id, { state: "after-login" });

    expect(initial.status).toBe(302);
    const login = new URL(initial.headers.get("location")!);
    expect(login.pathname).toBe("/login");
    const returnTo = login.searchParams.get("returnTo");
    expect(returnTo).toContain(`${BASE}/authorize?`);
    expect(new URL(returnTo!).searchParams.get("state")).toBe("after-login");

    subject = "user_1";
    const resumed = await harness.door.handler(new Request(returnTo!));
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get("content-type")).toContain("text/html");
    expect(await resumed.text()).toContain("Allow Test client to access this product?");
    expect(sessionCalls).toHaveLength(2);
    expect(sessionCalls[0]?.returnTo).toBe(sessionCalls[1]?.returnTo);
  });

  it("renders a themeable consent page and escapes a hostile DCR client_name", async () => {
    const hostileName = '<img src=x onerror="globalThis.pwned=1"><script>alert(1)</script>';
    const harness = makeHarness({ oauth: prebuiltOAuth(), theme: CONSENT_THEME });
    const registered = await register(harness.door, { client_name: hostileName });
    const response = await authorize(harness.door, registered.body.client_id);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(html).toContain("--vendo-color-accent");
    expect(html).toContain("--vendo-radius-medium");
    expect(html).toContain("--vendo-color-accent:#ffb81c");
    expect(html).toContain("--vendo-heading-family:Newsreader, serif");
    expect(html).toContain("--vendo-motion:reduced");
    expect(html).not.toContain(hostileName);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt;");
  });

  it("denies through the standard OAuth redirect and rejects a missing CSRF token", async () => {
    const harness = makeHarness({ oauth: prebuiltOAuth() });
    const registered = await register(harness.door);
    const page = await authorize(harness.door, registered.body.client_id, { state: "deny-state" });
    const html = await page.text();

    const csrfFailure = await submitConsent(harness.door, html, "deny", { csrfToken: "wrong" });
    expect(csrfFailure.status).toBe(400);
    expect(await csrfFailure.json()).toMatchObject({ error: "invalid_request" });

    const denied = await submitConsent(harness.door, html, "deny");
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("deny-state");
    expect(harness.store.rows("vendo_mcp_grants").some((row) => row.data.kind === "code")).toBe(false);
  });

  it("consumes an approved consent interaction once and rejects a replay", async () => {
    const harness = makeHarness({ oauth: prebuiltOAuth() });
    const registered = await register(harness.door);
    const page = await authorize(harness.door, registered.body.client_id, { state: "approve-state" });
    const html = await page.text();

    const approved = await submitConsent(harness.door, html, "approve");
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location")!);
    const code = location.searchParams.get("code");
    expect(code).toMatch(/^vmcd_/);
    expect(location.searchParams.get("state")).toBe("approve-state");

    const replay = await submitConsent(harness.door, html, "approve");
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_request" });

    const token = await exchange(harness.door, {
      code: code!,
      client_id: registered.body.client_id,
      code_verifier: VERIFIER,
      resource: BASE,
    });
    expect(token.status).toBe(200);
  });

  it("lets authorize replace the page while the door keeps the consent flow", async () => {
    let customFlow: { action: string; transaction: string; csrfToken: string } | undefined;
    const harness = makeHarness({
      oauth: {
        async session() { return { subject: "user_1" }; },
        async authorize(_req, ctx) {
          customFlow = ctx.consent;
          return new Response("<!doctype html><p>Host-branded consent</p>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
        async principal(subject) { return { kind: "user", subject }; },
      },
    });
    const registered = await register(harness.door);
    const page = await authorize(harness.door, registered.body.client_id);

    expect(await page.text()).toContain("Host-branded consent");
    expect(customFlow).toMatchObject({
      action: expect.stringContaining(`${BASE}/authorize?`),
      transaction: expect.stringMatching(/^vmci_/),
      csrfToken: expect.stringMatching(/^vmcsrf_/),
    });
    const approved = await submitConsentFields(harness.door, customFlow!, "approve");
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.get("location")!).searchParams.get("code")).toMatch(/^vmcd_/);
  });
});

describe("createMcpDoor configured canonical base URL (ENG-333)", () => {
  const PUBLIC_ORIGIN = "https://product.example";

  it("serves discovery documents with the configured public origin behind a proxy", async () => {
    const harness = makeHarness({ baseUrl: PUBLIC_ORIGIN });
    const prm = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(await prm.json()).toEqual({
      resource: BASE,
      authorization_servers: [BASE],
      bearer_methods_supported: ["header"],
    });

    const as = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-authorization-server/api/vendo/mcp",
    ));
    expect(await as.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      revocation_endpoint: `${BASE}/revoke`,
      registration_endpoint: `${BASE}/register`,
    });
  });

  it("advertises the configured public origin on the server card behind a proxy", async () => {
    const harness = makeHarness({ baseUrl: PUBLIC_ORIGIN, mount: "/api/vendo/mcp" });
    const card = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/mcp/server-card.json",
    ));
    expect(await card.json()).toMatchObject({
      transports: [{ type: "streamable-http", url: BASE }],
      authorization: {
        type: "oauth2",
        resource_metadata: "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
      },
    });
  });

  it("names the public metadata URL in the 401 challenge on the proxy-internal origin", async () => {
    const harness = makeHarness({ baseUrl: PUBLIC_ORIGIN });
    const challenge = await harness.door.handler(new Request(PROXIED_BASE, { method: "POST" }));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp"',
    );
  });

  it("binds the whole proxied OAuth flow and RFC 8707 audience to the public origin", async () => {
    const harness = makeHarness({ baseUrl: PUBLIC_ORIGIN });
    // Every request arrives at the proxy-INTERNAL origin, the way Railway/Fly
    // hand requests to the process. The `resource` the client sends is the
    // PUBLIC one it discovered.
    const registration = await register(harness.door, {}, PROXIED_BASE);
    const tokens = await issue(harness.door, registration.body.client_id, PROXIED_BASE);

    const response = await harness.door.handler(mcpRequest(tokens.access_token, undefined, PROXIED_BASE));
    expect(response.status).toBe(200);
    expect(harness.principalSubjects).toEqual(["user_1"]);
  });

  it("keeps the prebuilt consent flow on the public origin behind a proxy", async () => {
    const returnTos: string[] = [];
    const harness = makeHarness({
      baseUrl: PUBLIC_ORIGIN,
      oauth: {
        async session(_req, ctx) {
          returnTos.push(ctx.returnTo);
          return { subject: "user_1" };
        },
        async principal(subject) { return { kind: "user", subject }; },
      },
    });
    const registration = await register(harness.door, {}, PROXIED_BASE);
    const page = await authorize(harness.door, registration.body.client_id, {}, PROXIED_BASE);
    const html = await page.text();

    // The user's BROWSER reached the door through the public origin; a form
    // action or host-login returnTo naming the proxy-internal origin would be
    // unreachable from it. Both must speak the configured public base.
    expect(htmlAttribute(html, "form", "action")).toContain(`${BASE}/authorize?`);
    expect(returnTos[0]).toContain(`${BASE}/authorize?`);

    const approved = await submitConsent(harness.door, html, "approve");
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.get("location")!).searchParams.get("code")).toMatch(/^vmcd_/);
  });

  it("rejects an authorization request whose resource names the proxy-internal origin", async () => {
    const harness = makeHarness({ baseUrl: PUBLIC_ORIGIN });
    const registration = await register(harness.door, {}, PROXIED_BASE);
    const response = await authorize(harness.door, registration.body.client_id, { resource: PROXIED_BASE }, PROXIED_BASE);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("keeps request-derived origins and ignores forwarded headers when unconfigured", async () => {
    const harness = makeHarness();
    // X-Forwarded-*/Host are attacker-controllable (Host-header injection) and
    // are never trusted — without a configured base the request URL stands.
    const prm = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-protected-resource/api/vendo/mcp",
      { headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https", host: "attacker.example" } },
    ));
    expect(await prm.json()).toMatchObject({
      resource: "http://door.internal:8787/api/vendo/mcp",
      authorization_servers: ["http://door.internal:8787/api/vendo/mcp"],
    });
  });

  it("ignores forwarded headers even when a base URL is configured", async () => {
    const harness = makeHarness({ baseUrl: PUBLIC_ORIGIN });
    const prm = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-protected-resource/api/vendo/mcp",
      { headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" } },
    ));
    expect(await prm.json()).toMatchObject({ resource: BASE });
  });

  it("uses only the origin of a base URL that carries a path", async () => {
    const harness = makeHarness({ baseUrl: "https://product.example/some/app/path" });
    const prm = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(await prm.json()).toMatchObject({ resource: BASE });
  });

  it("advertises the external issuer alongside the public resource under remoteAs", async () => {
    const harness = makeHarness({
      baseUrl: PUBLIC_ORIGIN,
      remoteAs: { issuer: "https://auth.example", audience: BASE },
    });
    const prm = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(await prm.json()).toEqual({
      resource: BASE,
      authorization_servers: ["https://auth.example"],
      bearer_methods_supported: ["header"],
    });
  });

  it("throws at construction for a malformed or credentialed base URL", () => {
    for (const baseUrl of ["not a url", "ftp://product.example", "https://user:secret@product.example"]) {
      expect(() => makeHarness({ baseUrl }), baseUrl).toThrow(TypeError);
    }
  });
});

describe("createMcpDoor remote authorization server trust", () => {
  it("trusts the configured audience when a proxy changes the request origin", async () => {
    const as = await remoteAsFixture();
    vi.stubGlobal("fetch", as.fetch);
    const harness = makeHarness({
      remoteAs: { issuer: as.issuer, audience: BASE },
      principal: (subject) => ({ kind: "user", subject }),
    });

    const token = await as.mint({ sub: "proxied_user" });
    const response = await harness.door.handler(mcpRequest(token, undefined, PROXIED_BASE));

    expect(response.status).toBe(200);
    expect(harness.principalSubjects).toEqual(["proxied_user"]);
  });

  it("rejects a wrong-audience JWT even when the request arrives through a proxy", async () => {
    const as = await remoteAsFixture();
    vi.stubGlobal("fetch", as.fetch);
    const harness = makeHarness({ remoteAs: { issuer: as.issuer, audience: BASE } });

    const token = await as.mint({ audience: "https://attacker.example/api/vendo/mcp" });
    const response = await harness.door.handler(mcpRequest(token, undefined, PROXIED_BASE));

    expect(response.status).toBe(401);
    expect(harness.principalSubjects).toEqual([]);
  });

  it("keeps request-derived resource binding in local authorization-server mode", async () => {
    const harness = makeHarness();
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);

    const response = await harness.door.handler(mcpRequest(tokens.access_token, undefined, PROXIED_BASE));

    expect(response.status).toBe(401);
    expect(harness.principalSubjects).toEqual([]);
  });

  it("discovers and caches ES256 JWKS, accepts a valid JWT, and keeps principal() as the host kill switch", async () => {
    const as = await remoteAsFixture();
    vi.stubGlobal("fetch", as.fetch);
    const harness = makeHarness({
      remoteAs: { issuer: as.issuer, audience: BASE },
      principal: (subject) => ({ kind: "user", subject }),
    });

    const token = await as.mint({ sub: "external_user" });
    const connected = await connect(harness.door, token);
    expect((await connected.client.listTools()).tools).toHaveLength(1);
    expect(harness.principalSubjects.length).toBeGreaterThan(0);
    expect(new Set(harness.principalSubjects)).toEqual(new Set(["external_user"]));
    expect(as.fetch).toHaveBeenCalledTimes(2); // one RFC 8414 discovery + one JWKS fetch

    await connected.client.listTools();
    expect(as.fetch).toHaveBeenCalledTimes(2); // cached discovery and keys
    await connected.client.close();
  });

  it.each([
    ["issuer", { issuer: "https://attacker.example" }],
    ["audience", { audience: "https://other.example/mcp" }],
    ["expiry", { expiresAt: Math.floor(Date.now() / 1_000) - 1 }],
  ])("rejects a JWT with a bad %s", async (_case, overrides) => {
    const as = await remoteAsFixture();
    vi.stubGlobal("fetch", as.fetch);
    const harness = makeHarness({ remoteAs: { issuer: as.issuer, audience: BASE } });
    const token = await as.mint(overrides);

    const response = await harness.door.handler(mcpRequest(token));
    expect(response.status).toBe(401);
    expect(harness.principalSubjects).toEqual([]);
  });

  it("rejects a JWT whose signature does not match the trusted key", async () => {
    const as = await remoteAsFixture();
    vi.stubGlobal("fetch", as.fetch);
    const harness = makeHarness({ remoteAs: { issuer: as.issuer, audience: BASE } });
    const untrusted = await generateSigningKey("initial");
    const token = await mintRemoteToken(untrusted.privateKey, untrusted.kid, {
      issuer: as.issuer,
      audience: BASE,
      sub: "forged_user",
    });

    expect((await harness.door.handler(mcpRequest(token))).status).toBe(401);
    expect(harness.principalSubjects).toEqual([]);
  });

  it("rejects an unknown kid and refreshes cached JWKS when a new kid appears", async () => {
    const as = await remoteAsFixture();
    vi.stubGlobal("fetch", as.fetch);
    const harness = makeHarness({
      remoteAs: { issuer: as.issuer, jwksUri: as.jwksUri, audience: BASE },
      principal: (subject) => ({ kind: "user", subject }),
    });

    expect((await harness.door.handler(mcpRequest(await as.mint({ sub: "before_rotation" })))).status).toBe(200);

    const unknown = await generateSigningKey("unknown");
    const unknownToken = await mintRemoteToken(unknown.privateKey, unknown.kid, {
      issuer: as.issuer,
      audience: BASE,
      sub: "unknown_key",
    });
    expect((await harness.door.handler(mcpRequest(unknownToken))).status).toBe(401);
    expect(harness.principalSubjects).not.toContain("unknown_key");

    await as.rotate("rotated");
    expect((await harness.door.handler(mcpRequest(await as.mint({ sub: "after_rotation" })))).status).toBe(200);
    expect(harness.principalSubjects).toEqual(["before_rotation", "after_rotation"]);
    expect(as.fetch).toHaveBeenCalledTimes(3); // initial, unknown-kid refresh, rotation refresh
  });

  it("disables the local AS surface and advertises only the configured remote issuer", async () => {
    const as = await remoteAsFixture();
    const harness = makeHarness({ remoteAs: { issuer: as.issuer, jwksUri: as.jwksUri, audience: BASE } });

    const prm = await harness.door.handler(new Request(
      "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(await prm.json()).toEqual({
      resource: BASE,
      authorization_servers: [as.issuer],
      bearer_methods_supported: ["header"],
    });

    for (const request of [
      new Request(`${BASE}/authorize`),
      new Request(`${BASE}/authorize`, { method: "POST" }),
      new Request(`${BASE}/token`, { method: "POST" }),
      new Request(`${BASE}/revoke`, { method: "POST" }),
      new Request(`${BASE}/register`, { method: "POST" }),
      new Request("https://product.example/.well-known/oauth-authorization-server/api/vendo/mcp"),
    ]) {
      const response = await harness.door.handler(request);
      expect(response.status).toBe(404);
    }
  });
});

describe("createMcpDoor login federation", () => {
  const secret = "test-federation-secret-with-enough-entropy";
  const issuer = "https://as.example/oauth";
  const redirectUri = "https://as.example/login/callback?state=kept";

  it("round-trips a signed login request through the host adapter and returns a one-minute assertion", async () => {
    const harness = makeHarness({
      federation: { secret },
      authorizeSubject: () => "host_user_7",
    });
    const request = await mintFederationRequest(secret, { issuer, redirectUri });

    const response = await harness.door.handler(new Request(`${BASE}/federate?request=${encodeURIComponent(request)}`));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://as.example/login/callback");
    expect(location.searchParams.get("state")).toBe("kept");
    expect(harness.authorizeContexts).toEqual([{ clientName: "Generic MCP client", scopes: ["tools", "apps"] }]);

    const assertion = location.searchParams.get("assertion")!;
    const verified = await jwtVerify(assertion, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      issuer: BASE,
      audience: issuer,
    });
    expect(verified.payload).toMatchObject({
      iss: BASE,
      aud: issuer,
      sub: "host_user_7",
      jti: "federation-request-1",
    });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(60);
  });

  it("returns a host login bounce unchanged so the browser can retry the same signed request", async () => {
    const bounce = new Response(null, { status: 302, headers: { location: "/login?return_to=federate" } });
    const harness = makeHarness({ federation: { secret }, authorizeResponse: bounce });
    const request = await mintFederationRequest(secret, { issuer, redirectUri });

    const response = await harness.door.handler(new Request(`${BASE}/federate?request=${encodeURIComponent(request)}`));
    expect(response).toBe(bounce);
  });

  it("federates through a session-only (prebuilt-flow) adapter — authentication without host consent", async () => {
    // Federation delegates the consent decision to the external authorization
    // server, so a host that wired only the prebuilt `session` flow must still
    // be able to answer the login handshake (ENG-286).
    const sessionContexts: Array<{ returnTo: string }> = [];
    const harness = makeHarness({
      federation: { secret },
      oauth: {
        async session(_req, ctx) {
          sessionContexts.push(ctx);
          return { subject: "session_user_3" };
        },
        async principal(subject) { return { kind: "user", subject }; },
      },
    });
    const request = await mintFederationRequest(secret, { issuer, redirectUri });
    const federateUrl = `${BASE}/federate?request=${encodeURIComponent(request)}`;

    const response = await harness.door.handler(new Request(federateUrl));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    const assertion = location.searchParams.get("assertion")!;
    const verified = await jwtVerify(assertion, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      issuer: BASE,
      audience: issuer,
    });
    expect(verified.payload).toMatchObject({ sub: "session_user_3", jti: "federation-request-1" });
    // The session flow's returnTo is the federate request itself, so a host
    // login bounce can send the browser back to retry the same handshake.
    expect(sessionContexts).toEqual([{ returnTo: federateUrl }]);
  });

  it("returns a session-only adapter's login bounce unchanged so the browser can retry after host login", async () => {
    const bounce = new Response(null, { status: 302, headers: { location: "/login?returnTo=federate" } });
    const harness = makeHarness({
      federation: { secret },
      oauth: {
        async session() { return bounce; },
        async principal(subject) { return { kind: "user", subject }; },
      },
    });
    const request = await mintFederationRequest(secret, { issuer, redirectUri });

    const response = await harness.door.handler(new Request(`${BASE}/federate?request=${encodeURIComponent(request)}`));
    expect(response).toBe(bounce);
  });

  it.each([
    ["bad signature", "different-secret", {}],
    ["expired request", secret, { expiresAt: Math.floor(Date.now() / 1_000) - 1 }],
    ["wrong audience", secret, { audience: "https://other.example/mcp" }],
    ["redirect origin mismatch", secret, { redirectUri: "https://evil.example/callback" }],
  ])("rejects %s before calling the host adapter", async (_case, signingSecret, overrides) => {
    const harness = makeHarness({ federation: { secret } });
    const request = await mintFederationRequest(signingSecret, { issuer, redirectUri, ...overrides });

    const response = await harness.door.handler(new Request(`${BASE}/federate?request=${encodeURIComponent(request)}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(harness.authorizeContexts).toEqual([]);
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
      tree: { formatVersion: "vendo-genui/v2", root: "root", nodes: [] },
    };
    const apps: AppsPort = {
      async list() { return [app]; },
      async open() { return { kind: "tree", payload: app.tree! }; },
      async call(_appId, _ref, args) { return { received: args }; },
    };
    const harness = makeHarness({
      apps,
      theme: {
        ...MAPLE_THEME,
        typography: {
          ...MAPLE_THEME.typography,
          headingFamily: "Maple Display</style><script>alert(1)</script>",
        },
      },
    });
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
    const html = "text" in resource.contents[0]! ? resource.contents[0].text : "";
    expect(html).toContain("--vendo-color-background:#FBFBFA");
    expect(html).toContain("--vendo-color-accent:#0A7CFF");
    expect(html).toContain("--vendo-font-family:Maple Sans, system-ui, sans-serif");
    expect(html).not.toContain("</style><script>alert(1)</script>");
    expect(html).toContain("--vendo-heading-family:Maple Display\\3c /style\\3e ");
    expect(html.slice(0, html.indexOf("<script>"))).not.toContain("--color-text-primary");
    await connected.client.close();
  });

  it("does not send already-resolved tree queries back to the MCP shim", async () => {
    const payload = {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [],
      data: { total: 42 },
      queries: [{ name: "total", tool: "host_total" }],
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
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [],
      data: { total: 42 },
    });
    expect(payload.queries).toEqual([{ name: "total", tool: "host_total" }]);
    await connected.client.close();
  });

  it("projects an HTTP app into a tagged open-in-product envelope with useful text", async () => {
    const app: AppDocument = {
      format: "vendo/app@1",
      id: "app_http",
      name: "Revenue dashboard",
      ui: "http",
      server: "fixture:http",
    };
    const apps: AppsPort = {
      async list() { return [app]; },
      async open() { return { kind: "http", url: "https://apps.example/revenue" }; },
      async call() { return null; },
    };
    const harness = makeHarness({ apps });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    const opened = await connected.client.callTool({
      name: "vendo_apps_open",
      arguments: { appId: app.id },
    });
    expect(opened.structuredContent).toEqual({
      kind: "vendo/open-in-product@1",
      url: "https://apps.example/revenue",
      appName: "Revenue dashboard",
      productName: expect.any(String),
    });
    expect(opened.content).toEqual([expect.objectContaining({
      type: "text",
      text: expect.stringMatching(/Open Revenue dashboard in .+: https:\/\/apps\.example\/revenue/),
    })]);
    await connected.client.close();
  });

  it("gives vendo_apps_* door tools full guard treatment with venue mcp", async () => {
    const apps: AppsPort = {
      async list() { return []; },
      async open() { return { kind: "tree", payload: { formatVersion: "vendo-genui/v2" } }; },
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
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [],
      data: { via: "registry" },
      queries: [{ name: "via", tool: "host_source" }],
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
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [],
      data: { via: "registry" },
    });
    expect(treePayload.queries).toEqual([{ name: "via", tool: "host_source" }]);
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
  principal?: (subject: string) => Principal | null;
  apps?: AppsPort;
  extraDescriptors?: Awaited<ReturnType<ToolRegistry["descriptors"]>>;
  check?: Guard["check"];
  mount?: string;
  baseUrl?: string;
  remoteAs?: { issuer: string; jwksUri?: string; audience: string };
  federation?: { secret: string };
  authorizeResponse?: Response;
  theme?: VendoTheme;
  /** The subject the OAuth authorize step returns (defaults "user_1"); a fn lets
   * a test mint tokens for two different subjects against one door (FIX G). */
  authorizeSubject?: () => string;
  oauth?: HostOAuthAdapter;
}

function makeHarness(options: HarnessOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const audits: AuditEvent[] = [];
  const authorizeContexts: Array<{ clientName: string; scopes: string[] }> = [];
  const principalSubjects: string[] = [];
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
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.remoteAs === undefined ? {} : { remoteAs: options.remoteAs }),
    ...(options.federation === undefined ? {} : { federation: options.federation }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    oauth: options.oauth ?? {
      async authorize(_req, ctx) {
        authorizeContexts.push(ctx);
        if (options.authorizeResponse) return options.authorizeResponse;
        return { subject: options.authorizeSubject ? options.authorizeSubject() : "user_1" };
      },
      async principal(subject) {
        principalSubjects.push(subject);
        return options.principal ? options.principal(subject) : { kind: "user", subject: "user_1" };
      },
    },
  };
  const door = options.state === undefined
    ? createMcpDoor(config)
    : createMcpDoorWithState(config, options.state);
  return { door, store, audits, authorizeContexts, principalSubjects, executions };
}

async function register(door: McpDoor, metadata: Record<string, unknown> = {}, base = BASE) {
  const response = await door.handler(new Request(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test client", redirect_uris: [REDIRECT], scope: "read write", ...metadata }),
  }));
  return { response, body: await response.clone().json() as { client_id: string } & Record<string, unknown> };
}

async function authorize(door: McpDoor, clientId: string, overrides: Record<string, string> = {}, base = BASE) {
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
  return door.handler(new Request(`${base}/authorize?${params}`));
}

function prebuiltOAuth(): HostOAuthAdapter {
  return {
    async session() { return { subject: "user_1" }; },
    async principal(subject) { return { kind: "user", subject }; },
  };
}

async function submitConsent(
  door: McpDoor,
  html: string,
  decision: "approve" | "deny",
  overrides: { csrfToken?: string } = {},
): Promise<Response> {
  const action = htmlAttribute(html, "form", "action").replaceAll("&amp;", "&");
  return submitConsentFields(door, {
    action,
    transaction: inputValue(html, "transaction"),
    csrfToken: overrides.csrfToken ?? inputValue(html, "csrf_token"),
  }, decision);
}

async function submitConsentFields(
  door: McpDoor,
  flow: { action: string; transaction: string; csrfToken: string },
  decision: "approve" | "deny",
): Promise<Response> {
  return door.handler(new Request(flow.action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction: flow.transaction,
      csrf_token: flow.csrfToken,
      decision,
    }),
  }));
}

function inputValue(html: string, name: string): string {
  const match = html.match(new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]+)"`, "i"));
  if (!match?.[1]) throw new Error(`Consent page omitted ${name}`);
  return match[1];
}

function htmlAttribute(html: string, element: string, attribute: string): string {
  const match = html.match(new RegExp(`<${element}[^>]+${attribute}="([^"]+)"`, "i"));
  if (!match?.[1]) throw new Error(`Consent page omitted ${element}[${attribute}]`);
  return match[1];
}

async function exchange(door: McpDoor, values: Record<string, string>, base = BASE) {
  return door.handler(new Request(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      ...values,
    }),
  }));
}

async function issue(door: McpDoor, clientId: string, base = BASE): Promise<TokenResponse> {
  const auth = await authorize(door, clientId, {}, base);
  const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
  const response = await exchange(door, { code, client_id: clientId, code_verifier: VERIFIER, resource: BASE }, base);
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

async function revoke(door: McpDoor, token: string, clientId: string, tokenTypeHint?: string) {
  return door.handler(new Request(`${BASE}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: clientId,
      ...(tokenTypeHint === undefined ? {} : { token_type_hint: tokenTypeHint }),
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

function mcpRequest(accessToken: string, sessionId?: string, resource = BASE) {
  return new Request(resource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
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

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface RemoteTokenOverrides {
  issuer?: string;
  audience?: string;
  sub?: string;
  issuedAt?: number;
  expiresAt?: number;
}

async function generateSigningKey(kid: string) {
  const pair = await generateKeyPair("ES256");
  return { ...pair, kid };
}

async function mintRemoteToken(
  privateKey: KeyLike,
  kid: string,
  options: { issuer: string; audience: string } & RemoteTokenOverrides,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setSubject(options.sub ?? "external_user")
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(privateKey);
}

async function remoteAsFixture() {
  const issuer = "https://as.example";
  const jwksUri = `${issuer}/jwks`;
  let key = await generateSigningKey("initial");
  let jwks = { keys: [{ ...(await exportJWK(key.publicKey)), alg: "ES256", use: "sig", kid: key.kid }] };
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({ issuer, jwks_uri: jwksUri });
    }
    if (url === jwksUri) return Response.json(jwks);
    return new Response(null, { status: 404 });
  });
  return {
    issuer,
    jwksUri,
    fetch,
    async mint(overrides: RemoteTokenOverrides = {}) {
      return mintRemoteToken(key.privateKey, key.kid, {
        issuer: overrides.issuer ?? issuer,
        audience: overrides.audience ?? BASE,
        ...overrides,
      });
    },
    async rotate(kid: string) {
      key = await generateSigningKey(kid);
      jwks = { keys: [{ ...(await exportJWK(key.publicKey)), alg: "ES256", use: "sig", kid: key.kid }] };
    },
  };
}

async function mintFederationRequest(
  secret: string,
  options: {
    issuer: string;
    redirectUri: string;
    audience?: string;
    expiresAt?: number;
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    redirect_uri: options.redirectUri,
    scopes: ["tools", "apps"],
    client_name: "Generic MCP client",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(options.issuer)
    .setAudience(options.audience ?? BASE)
    .setJti("federation-request-1")
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(new TextEncoder().encode(secret));
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

  async deleteSessionsBySubjectClient(subject: string, clientId: string): Promise<McpStateSession[]> {
    this.operations.push(`session:delete-client:${subject}:${clientId}`);
    return this.#deleteSessionsWhere((record) => record.subject === subject && record.clientId === clientId);
  }

  async deleteSessionsByGrantFamily(familyId: string): Promise<McpStateSession[]> {
    this.operations.push(`session:delete-family:${familyId}`);
    return this.#deleteSessionsWhere((record) => record.grantFamilyId === familyId);
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

  #deleteSessionsWhere(predicate: (record: SessionStateRecord) => boolean): McpStateSession[] {
    const sessions: McpStateSession[] = [];
    for (const [sessionId, record] of this.#sessions) {
      if (!predicate(record)) continue;
      sessions.push(record.session);
      this.#sessions.delete(sessionId);
      this.#replay.delete(record.session.replayScope);
    }
    return sessions;
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
