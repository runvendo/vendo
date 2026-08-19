import {
  type AppDocument,
  type AuditEvent,
  type BlobStore,
  canonicalJson,
  type Guard,
  type Json,
  type Membership,
  type Principal,
  type RecordQuery,
  type RecordStore,
  type StoreAdapter,
  type ToolCall,
  type ToolListing,
  type ToolOutcome,
  type ToolRegistry,
  type VendoRecord,
} from "@vendoai/core";
import {
  type VendoTheme,
} from "@vendoai/apps/contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type CryptoKey } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpDoorWithState } from "../src/door.js";
import {
  createMcpDoor,
  type HostOAuthAdapter,
  type McpDoor,
  type McpDoorConfig,
  type TurnCredentialPort,
} from "../src/index.js";
import type {
  McpDoorState,
  McpStateSession,
  ReplayStateOptions,
  SessionStateRecord,
} from "../src/state.js";

/** The door's apps ride-along: three verbs off the real runtime (10-mcp §4). */
type AppsRideAlong = NonNullable<McpDoorConfig["apps"]>;

const BASE = "https://product.example/api/vendo/mcp";
const PROXIED_BASE = "http://door.internal:8787/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-test-suite-1234567890";
/** Two service keys, deliberately spelled nothing alike, because a key has no
 *  format the door checks. The label is `svc:` plus the first 8 hex of the key's
 *  sha256 — pinned literally here so a change to that derivation cannot pass. */
const SERVICE_KEY = "vsk_0123456789abcdef0123456789abcdef0123456789abcdef";
const SERVICE_KEY_B = "any opaque string will do - the door never parses a key";
const SERVICE_CLIENT = "svc:5c006a4c";
const SERVICE_CLIENT_B = "svc:67ed3026";
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

  it("keeps the standalone SSE slot reachable when a stream dies unread", async () => {
    // The door's 409 recovery survived the connector-discovery cutover, but its
    // only coverage did not: those tests drove it through `search_connectors`'
    // `list_changed` announcement, which was deleted with the tool. The recovery
    // is what it always was — measured live 2026-08-03, a standalone stream died
    // silently, the client's reconnects came back 409 "Only one SSE stream is
    // allowed per session", it gave up, and the session had no notification
    // channel left for the rest of its life. The transport frees a slot only
    // through the body's `cancel`, and a socket that just dies never fires it;
    // an unread, uncancelled body is exactly that state.
    //
    // Raw HTTP, not the SDK client: the client owns its own reconnect policy and
    // would never leave a session sitting in this state.
    const harness = makeHarness();
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const initialized = await harness.door.handler(mcpRequest(tokens.access_token));
    const sessionId = initialized.headers.get("mcp-session-id")!;

    // Every dead stream is HELD, and that is load-bearing: a body the runtime
    // collects has its `cancel` fired for it, which frees the slot by accident
    // and would prove nothing about the door. Held, the only thing that can free
    // it is the door's own recovery.
    const dead: Response[] = [await harness.door.handler(sseRequest(tokens.access_token, sessionId))];
    expect(dead[0]!.status).toBe(200);

    // Twice, because one recovery is not the property: the release has to leave
    // the DOOR holding the reconnected stream, or the second death is the
    // permanent one — a 409 nothing can free.
    for (let death = 0; death < 2; death += 1) {
      const reconnected = await harness.door.handler(sseRequest(tokens.access_token, sessionId));
      expect(reconnected.status).toBe(200);
      expect(reconnected.headers.get("content-type")).toContain("text/event-stream");
      dead.push(reconnected);
    }
    expect(dead).toHaveLength(3);

    // And none of it disturbed the session itself.
    expect((await harness.door.handler(mcpRequest(tokens.access_token, sessionId))).status).toBe(200);
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

  it("still delivers rotated tokens when the refresh audit write fails", async () => {
    let failReports = false;
    const harness = makeHarness({
      report: async () => {
        if (failReports) throw new Error("audit store unavailable");
      },
    });
    const client = await register(harness.door);
    const first = await issue(harness.door, client.body.client_id);

    // The rotation commits (new grants persisted, old grant marked rotated)
    // BEFORE the audit write, so a failing audit sink must not eat the
    // response — otherwise the client retries its only refresh token and
    // reuse detection revokes the whole (undelivered) grant family.
    failReports = true;
    const rotatedResponse = await refresh(harness.door, first.refresh_token, client.body.client_id);
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as TokenResponse;
    expect(rotated.refresh_token).not.toBe(first.refresh_token);

    // The delivered successor still refreshes: the family was not poisoned
    // into reuse-revocation by a lost response.
    failReports = false;
    const next = await refresh(harness.door, rotated.refresh_token, client.body.client_id);
    expect(next.status).toBe(200);
  });

  it("returns an empty 200 for an unknown token and ignores an unknown token type hint", async () => {
    const harness = makeHarness();
    const client = await register(harness.door);

    const response = await revoke(harness.door, "vmrt_unknown", client.body.client_id, "future_token_type");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(harness.audits.filter((event) => (event.detail as { event?: string } | undefined)?.event === "revoke")).toEqual([]);
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
      .filter((row) => (row.data as { kind?: string }).kind === "family")
      .map((row) => (row.data as { status?: string }).status)
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

  it("refuses an authorization code still outstanding when the client was revoked", async () => {
    const harness = makeHarness();
    const client = await register(harness.door);
    const auth = await authorize(harness.door, client.body.client_id);
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;

    // A code lives a minute; a revoke inside that window has to reach it. The
    // family anchor is what does it — the code carries the family id and the
    // exchange re-checks that the family is still active.
    await harness.door.revokeClient("user_1", client.body.client_id);

    const exchangeResponse = await exchange(harness.door, {
      code,
      client_id: client.body.client_id,
      code_verifier: VERIFIER,
      resource: BASE,
    });
    expect(exchangeResponse.status).toBe(400);
    expect(await exchangeResponse.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("revokes an outstanding service-key access grant, which carries no family", async () => {
    const harness = makeHarness({ serviceAuth: { keys: [SERVICE_KEY] } });
    const exchanged = await serviceExchange(harness.door);
    const { access_token: token } = await exchanged.json() as TokenResponse;
    expect((await harness.door.handler(mcpRequest(token))).status).toBe(200);

    // The service-key exchange mints ONE access grant and nothing else — no
    // refresh token, so no rotation and no family anchor to hang a revocation
    // on. Per-grant revocation is the only thing that can reach it.
    await harness.door.revokeClient("user_1", "vendo-service");
    expect((await harness.door.handler(mcpRequest(token))).status).toBe(200);

    await harness.door.revokeClient("user_1", `svc:${(await sha256Hex(SERVICE_KEY)).slice(0, 8)}`);
    expect((await harness.door.handler(mcpRequest(token))).status).toBe(401);
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
            return Response.redirect(login, 302);
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
    expect(harness.store.rows("vendo_mcp_grants").some((row) => (row.data as { kind?: string }).kind === "code")).toBe(false);
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

  it("folds a path on the base URL into the advertised resource", async () => {
    const harness = makeHarness({ baseUrl: "https://product.example/some/app/path" });
    const prm = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(await prm.json()).toMatchObject({
      resource: "https://product.example/some/app/path/api/vendo/mcp",
    });
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

describe("createMcpDoor mounted under a path prefix", () => {
  // A self-hosted deployment living under `https://product.example/maple`. The
  // reverse proxy strips `/maple` before the request reaches the process, so
  // the door sees only the door-local path — the base URL's path is the one
  // channel that can carry the prefix.
  const PREFIXED_BASE_URL = "https://product.example/maple";
  const PREFIXED_RESOURCE = "https://product.example/maple/api/vendo/mcp";
  const STRIPPED_MOUNT = "http://door.internal:8787/api/vendo/mcp";

  it("advertises OAuth endpoints under the same prefix the door is mounted on", async () => {
    const harness = makeHarness({ baseUrl: PREFIXED_BASE_URL });
    const as = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-authorization-server/api/vendo/mcp",
    ));
    expect(await as.json()).toMatchObject({
      issuer: PREFIXED_RESOURCE,
      authorization_endpoint: `${PREFIXED_RESOURCE}/authorize`,
      token_endpoint: `${PREFIXED_RESOURCE}/token`,
      revocation_endpoint: `${PREFIXED_RESOURCE}/revoke`,
      registration_endpoint: `${PREFIXED_RESOURCE}/register`,
    });
  });

  it("advertises the prefixed resource in the protected-resource metadata", async () => {
    const harness = makeHarness({ baseUrl: PREFIXED_BASE_URL });
    const prm = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(await prm.json()).toEqual({
      resource: PREFIXED_RESOURCE,
      authorization_servers: [PREFIXED_RESOURCE],
      bearer_methods_supported: ["header"],
    });
  });

  it("names a prefix-local metadata URL in the 401 challenge", async () => {
    const harness = makeHarness({ baseUrl: PREFIXED_BASE_URL });
    const challenge = await harness.door.handler(new Request(STRIPPED_MOUNT, { method: "POST" }));
    expect(challenge.status).toBe(401);
    // Prefix-local, not RFC 9728 root-insertion: the deployment only owns
    // paths under `/maple`, so a root well-known URL would never route to it.
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://product.example/maple/.well-known/oauth-protected-resource/api/vendo/mcp"',
    );
  });

  it("advertises the prefixed transport URL on the server card", async () => {
    const harness = makeHarness({ baseUrl: PREFIXED_BASE_URL, mount: "/api/vendo/mcp" });
    const card = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/mcp/server-card.json",
    ));
    expect(await card.json()).toMatchObject({
      transports: [{ type: "streamable-http", url: PREFIXED_RESOURCE }],
      authorization: {
        type: "oauth2",
        resource_metadata: "https://product.example/maple/.well-known/oauth-protected-resource/api/vendo/mcp",
      },
    });
  });

  it("answers discovery whose mount suffix already carries the prefix, without doubling it", async () => {
    // RFC 8414/9728 root-insertion: a spec client derives the well-known URL
    // from the FULL resource URI, so the suffix arrives prefix-INCLUDING.
    const harness = makeHarness({ baseUrl: PREFIXED_BASE_URL });
    const prm = await harness.door.handler(new Request(
      "http://door.internal:8787/.well-known/oauth-protected-resource/maple/api/vendo/mcp",
    ));
    expect(await prm.json()).toMatchObject({ resource: PREFIXED_RESOURCE });
  });

  it("serves a request that still carries the public prefix identically", async () => {
    // A prefix-PRESERVING mount (no stripping proxy) reaches the same door.
    const harness = makeHarness({ baseUrl: PREFIXED_BASE_URL });
    const challenge = await harness.door.handler(new Request(
      "http://door.internal:8787/maple/api/vendo/mcp",
      { method: "POST" },
    ));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://product.example/maple/.well-known/oauth-protected-resource/api/vendo/mcp"',
    );
  });

  it("keeps the consent flow under the prefix", async () => {
    const returnTos: string[] = [];
    const harness = makeHarness({
      baseUrl: PREFIXED_BASE_URL,
      oauth: {
        async session(_req, ctx) {
          returnTos.push(ctx.returnTo);
          return { subject: "user_1" };
        },
        async principal(subject) { return { kind: "user", subject }; },
      },
    });
    const registration = await register(harness.door, {}, STRIPPED_MOUNT);
    const page = await authorize(
      harness.door,
      registration.body.client_id,
      { resource: PREFIXED_RESOURCE },
      STRIPPED_MOUNT,
    );
    const html = await page.text();
    // The user's browser reaches the door THROUGH the prefix; a form action or
    // returnTo without it lands on the host's own 404 page.
    expect(htmlAttribute(html, "form", "action")).toContain(`${PREFIXED_RESOURCE}/authorize?`);
    expect(returnTos[0]).toContain(`${PREFIXED_RESOURCE}/authorize?`);
  });

  it("binds the whole OAuth flow and RFC 8707 audience to the prefixed resource", async () => {
    const harness = makeHarness({ baseUrl: PREFIXED_BASE_URL });
    const registration = await register(harness.door, {}, STRIPPED_MOUNT);
    const auth = await authorize(
      harness.door,
      registration.body.client_id,
      { resource: PREFIXED_RESOURCE },
      STRIPPED_MOUNT,
    );
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
    const exchanged = await exchange(harness.door, {
      code,
      client_id: registration.body.client_id,
      code_verifier: VERIFIER,
      resource: PREFIXED_RESOURCE,
    }, STRIPPED_MOUNT);
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json() as TokenResponse;

    const response = await harness.door.handler(mcpRequest(tokens.access_token, undefined, STRIPPED_MOUNT));
    expect(response.status).toBe(200);
    expect(harness.principalSubjects).toEqual(["user_1"]);
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

  it("accepts an RS256 access token, the default of the mainstream authorization servers", async () => {
    const as = await remoteAsFixture("RS256");
    vi.stubGlobal("fetch", as.fetch);
    const harness = makeHarness({
      remoteAs: { issuer: as.issuer, audience: BASE },
      principal: (subject) => ({ kind: "user", subject }),
    });

    const response = await harness.door.handler(mcpRequest(await as.mint({ sub: "rs256_user" })));

    expect(response.status).toBe(200);
    expect(harness.principalSubjects).toEqual(["rs256_user"]);
  });

  it("rejects an HS256 token forged from the published RSA key — the algorithm allowlist stays asymmetric", async () => {
    const as = await remoteAsFixture("RS256");
    vi.stubGlobal("fetch", as.fetch);
    const harness = makeHarness({ remoteAs: { issuer: as.issuer, audience: BASE } });

    // Classic algorithm confusion: sign HS256 with the public modulus everyone
    // can read off the JWKS. Only the allowlist stands between this and a token
    // anyone can mint.
    const secret = new TextEncoder().encode((await as.publicJwk()).n as string);
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: as.kid() })
      .setIssuer(as.issuer)
      .setAudience(BASE)
      .setSubject("forged_user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);

    expect((await harness.door.handler(mcpRequest(forged))).status).toBe(401);
    expect(harness.principalSubjects).toEqual([]);
  });

  it("refuses to compose a door whose remote authorization server has a blank issuer or audience", async () => {
    // jose skips the `aud`/`iss` VALUE check when the expected value is falsy,
    // so a blank one silently turns the audience binding off and every token
    // that server ever signed becomes good at this door.
    for (const remoteAs of [
      { issuer: "https://as.example", audience: "" },
      { issuer: "", audience: BASE },
    ]) {
      expect(() => makeHarness({ remoteAs })).toThrow(/issuer and audience/);
    }
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

/** F4 (wave-3 independent check) — build contract §9.1/§9.3. `can()` reads the
 *  caller's orgs from the ctx and NEVER queries them, so a RunContext with no
 *  `memberships` can never match an `org:`/`team:` grant: over a door without
 *  this seam a team app shared with you is absent from list and not-found on
 *  open. The wire, the harness and the automations engine all get the seam; this
 *  is the fourth door. */
describe("createMcpDoor asserts the caller's orgs (§9.1)", () => {
  it("resolves the host's memberships onto every RunContext it mints", async () => {
    const seen: Array<Parameters<AppsRideAlong["list"]>[0]> = [];
    const asked: Principal[] = [];
    const harness = makeHarness({
      memberships: async (principal) => {
        asked.push(principal);
        return [{ org: "maple", display: "Maple Bank", teams: ["support"] }];
      },
      apps: {
        async list(ctx) { seen.push(ctx); return []; },
        async open() { throw new Error("unused"); },
        async call() { throw new Error("unused"); },
      },
    });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    await connected.client.callTool({ name: "host_lookup", arguments: { query: "x" } });
    // The apps half of §9.3 goes through the door's own ride-along tool, which
    // is the verb a shared team app would be missing from.
    await connected.client.callTool({ name: "vendo_apps_list", arguments: {} });

    // The seam is keyed on the Principal, exactly as §9.1 freezes it.
    expect(asked[0]).toEqual({ kind: "user", subject: "user_1" });
    // ...and the answer REACHES the ctx — the assertion that was missing, and
    // the only thing `can()` ever reads.
    expect(harness.executions[0]?.ctx.memberships)
      .toEqual([{ org: "maple", display: "Maple Bank", teams: ["support"] }]);
    expect(seen[0]?.memberships)
      .toEqual([{ org: "maple", display: "Maple Bank", teams: ["support"] }]);
  });

  it("leaves memberships absent when the host asserts none — every unkeyed deployment", async () => {
    const harness = makeHarness();
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    await connected.client.callTool({ name: "host_lookup", arguments: { query: "x" } });

    expect(harness.executions[0]?.ctx).not.toHaveProperty("memberships");
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
      // risk-derived hints ride on every listing (this descriptor is untitled)
      annotations: { readOnlyHint: true, destructiveHint: false },
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
    // Raw HTTP, not the SDK client: the client's unawaited background SSE GET
    // could observe the null principal first, kill the subject, and hand THIS
    // request the 404 — exactly one request may be in flight across the flip.
    const initialized = await harness.door.handler(mcpRequest(tokens.access_token));
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id")!;

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
    const app: AppDocument = { format: "vendo/app@1", id: "app_1", name: "Dashboard" };
    // What OPENING the app renders — the payload a paint produces, which is what
    // the shim receives. No document carries one.
    const payload = { formatVersion: "vendo-genui/v2", root: "root", nodes: [] } as never;
    const apps: AppsRideAlong = {
      async list() { return [app]; },
      async open() { return { kind: "tree", payload }; },
      async call(_appId, _ref, args) { return { status: "ok", output: { received: args } as Json }; },
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
    expect(opened.structuredContent).toEqual(payload);
    const called = await connected.client.callTool({
      name: "vendo_apps_call",
      arguments: { appId: "app_1", ref: "host_lookup", args: { query: "x" } },
    });
    // The ride-along hands back the RUNTIME's own ToolOutcome, and the door
    // wraps it as its own `ok` output — the shape a real `vendo.apps.call`
    // produces. The deleted structural mirror typed this `unknown`, so a fake
    // returning a bare value was indistinguishable from the real producer.
    expect(called.structuredContent).toEqual({ status: "ok", output: { received: { query: "x" } } });

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
    const apps: AppsRideAlong = {
      async list() { return []; },
      async open() { return { kind: "tree", payload }; },
      async call() { return { status: "ok", output: null }; },
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
    };
    const apps: AppsRideAlong = {
      async list() { return [app]; },
      async open() { return { kind: "http", url: "https://apps.example/revenue" }; },
      async call() { return { status: "ok", output: null }; },
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
    const apps: AppsRideAlong = {
      async list() { return []; },
      async open() { return { kind: "tree", payload: { formatVersion: "vendo-genui/v2" } }; },
      async call() { return { status: "ok", output: { done: true } }; },
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

  it("refuses malformed apps-tool args before the guard can park an approval", async () => {
    const apps: AppsRideAlong = {
      async list() { return []; },
      async open() { return { kind: "tree", payload: { formatVersion: "vendo-genui/v2" } }; },
      async call() { return { status: "ok", output: { done: true } }; },
    };
    // `check` is where an approval is MINTED, so the calls it sees are exactly
    // the approvals this door could leave parked for a human to resolve.
    const asked: string[] = [];
    const harness = makeHarness({
      apps,
      check: async (call, descriptor, ctx) => {
        asked.push(call.tool);
        return {
          action: "ask",
          decidedBy: "rule",
          approval: {
            id: `apr_${asked.length}`,
            call,
            descriptor,
            inputPreview: call.tool,
            ctx: { principal: ctx.principal, venue: ctx.venue, presence: ctx.presence },
            createdAt: new Date().toISOString(),
          },
        };
      },
    });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    const refused = await connected.client.callTool({ name: "vendo_apps_call", arguments: { appId: "app_1" } });
    expect(refused).toMatchObject({ isError: true, content: [{ text: "validation: ref is required" }] });
    expect(asked).toEqual([]);
    expect(harness.audits.filter((event) => event.kind === "tool-call")).toEqual([]);

    // The same tool, well formed, DOES park — so it is the args that were
    // refused and not the tool.
    const parked = await connected.client.callTool({
      name: "vendo_apps_call",
      arguments: { appId: "app_1", ref: "host_write", args: {} },
    });
    expect(parked).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("apr_1") }] });
    expect(asked).toEqual(["vendo_apps_call"]);
    await connected.client.close();
  });

  it("beats notifications/progress at a client that sent a progressToken", async () => {
    let beat!: (progress: { progress: number }) => void;
    const firstBeat = new Promise<{ progress: number }>((resolve) => { beat = resolve; });
    const apps: AppsRideAlong = {
      // The call returns only once the beat has landed AT THE CLIENT, so a door
      // that emits nothing — or emits where `enableJsonResponse` drops it —
      // hangs here instead of passing.
      async list() { await firstBeat; return []; },
      async open() { return { kind: "tree", payload: { formatVersion: "vendo-genui/v2" } }; },
      async call() { return { status: "ok", output: { done: true } }; },
    };
    const harness = makeHarness({ apps });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);
    // One round trip first, so the SDK's unawaited background GET — the stream
    // the beat is written to — is registered before the call goes out.
    await connected.client.listTools();

    const result = await connected.client.callTool(
      { name: "vendo_apps_list", arguments: {} },
      undefined,
      { onprogress: beat, resetTimeoutOnProgress: true },
    );
    expect((await firstBeat).progress).toBe(1);
    expect(result.isError).toBeUndefined();
    await connected.client.close();
  });

  it("returns the executed apps-tool result even when the audit write fails", async () => {
    const apps: AppsRideAlong = {
      async list() { return []; },
      async open() { return { kind: "tree", payload: { formatVersion: "vendo-genui/v2" } }; },
      async call() { return { status: "ok", output: { done: true } }; },
    };
    let failReports = false;
    const harness = makeHarness({
      apps,
      report: async () => {
        if (failReports) throw new Error("audit store unavailable");
      },
    });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);

    // The tool already executed before the audit write; a failing report must
    // surface the computed in-band result, never a JSON-RPC protocol error
    // (10-mcp §2) that would invite a double-executing retry.
    failReports = true;
    const result = await connected.client.callTool({ name: "vendo_apps_list", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    expect(textOf(result)).toBe("[]");
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
    const apps: AppsRideAlong = {
      async list() { return []; },
      async open() { return { kind: "http", url: "https://app.example" }; },
      async call() { return { status: "ok", output: null }; },
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
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: { resourceUri: "ui://vendo/tree-shim.html" },
        "ui/resourceUri": "ui://vendo/tree-shim.html",
      },
    }]);
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["vendo_apps_list", "vendo_apps_call"]),
    );

    // Execution routes through the registry (one guard decision), not the
    // AppsRideAlong — and the door unwraps its OpenSurface into a bare, shim-renderable
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

/**
 * `internal: true` is AUTHORITATIVE, whatever else the caller passed.
 *
 * `createMcpDoor` is public API and `internal` is documented as the way to ask
 * for a turn-only door. It was first shipped read in ONE place — a constructor
 * guard — while the runtime branched on "is there an oauth adapter", so
 * `createMcpDoor({ internal: true, oauth })` served the WHOLE OUTSIDE DOOR:
 * discovery 200, a client that actually completed dynamic registration, and a
 * `www-authenticate` challenge naming the way in. The caller got the exact
 * opposite of what they asked for. These pin the flag, with oauth present.
 */
describe("createMcpDoor internal: true is authoritative even when an oauth adapter is passed", () => {
  const internalHarness = () => makeHarness({ internal: true, mount: "/api/vendo/mcp" });

  it("serves NO discovery: an outside client cannot even learn the door is there", async () => {
    const { door } = internalHarness();
    for (const path of [
      "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
      "https://product.example/.well-known/oauth-authorization-server/api/vendo/mcp",
      "https://product.example/.well-known/mcp/server-card.json",
      "https://product.example/.well-known/mcp-server-card",
    ]) {
      const response = await door.handler(new Request(path));
      expect(response.status, path).toBe(404);
    }
  });

  it("registers NOBODY: the authorization server and the connect page are not there", async () => {
    const { door } = internalHarness();
    const registered = await door.handler(new Request(`${BASE}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "outside", redirect_uris: [REDIRECT] }),
    }));
    // 201 here was the defect: a real client id was minted against a door that
    // had been asked to serve nobody.
    expect(registered.status).toBe(404);

    for (const path of [`${BASE}/authorize?response_type=code&client_id=x`, `${BASE}/token`, `${BASE}/connect`]) {
      const response = await door.handler(new Request(path, path.endsWith("/token") ? { method: "POST" } : {}));
      expect(response.status, path).toBe(404);
    }
  });

  it("refuses the mount FLAT: a 401 that names no resource metadata to register against", async () => {
    const { door } = internalHarness();
    const response = await door.handler(new Request(BASE, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});

describe("createMcpDoor connect page", () => {
  const get = (door: McpDoor, path = `${BASE}/connect`) => door.handler(new Request(path));

  it("serves a themed, unauthenticated page naming the product and the exact MCP URL", async () => {
    const harness = makeHarness({ theme: MAPLE_THEME, mount: "/api/vendo/mcp" });
    const response = await get(harness.door);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();

    // The URL a client must paste — absolute, and the door's real mount.
    expect(html).toContain("https://product.example/api/vendo/mcp");
    // Host identity, and the theme applied as --vendo-* variables like consent.
    expect(html).toContain("--vendo-color-accent:#0A7CFF");
    expect(html).toContain("Maple Sans");
    // No session was consulted to render it.
    expect(harness.principalSubjects).toEqual([]);
  });

  it("gives working per-client instructions for Claude, ChatGPT, and Cursor", async () => {
    const html = await (await get(makeHarness().door)).text();
    expect(html).toContain("Claude");
    expect(html).toContain("Connectors");
    expect(html).toContain("ChatGPT");
    expect(html).toContain("developer mode");
    expect(html).toContain("Cursor");
    // A real one-click Cursor deeplink: base64 of {"url":"<mcp url>"}.
    const config = Buffer.from(JSON.stringify({ url: "https://product.example/api/vendo/mcp" })).toString("base64");
    expect(html).toContain("cursor://anysphere.cursor-deeplink/mcp/install");
    expect(html).toContain(encodeURIComponent(config));
  });

  it("carries the same locked-down CSP posture as the consent page, and no script at all", async () => {
    const response = await get(makeHarness().door);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(await response.text()).not.toContain("<script");
  });

  it("prefers an explicitly configured product name over package.json", async () => {
    const html = await (await get(makeHarness({ productName: "Maple" }).door)).text();
    expect(html).toContain("Connect Maple to your AI client");
    expect(html).not.toContain("@vendoai/mcp");
  });

  it("puts the configured product name on the server card too, so both surfaces agree", async () => {
    const harness = makeHarness({ productName: "Maple", mount: "/api/vendo/mcp" });
    const card = await harness.door.handler(new Request("https://product.example/.well-known/mcp/server-card.json"));
    expect((await card.json() as { name?: string }).name).toBe("Maple");
  });

  it("warns once, naming the path it tried, when host identity falls back to the generic name", async () => {
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line: string) => { warned.push(line); });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-host-root");
    try {
      const harness = makeHarness();
      const html = await (await get(harness.door)).text();
      // The page is human-visible now, so a silent generic name is a bug.
      expect(html).toContain("Connect vendo to your AI client");
      const identityWarnings = warned.filter((line) => line.includes("/nonexistent-host-root/package.json"));
      expect(identityWarnings).toHaveLength(1);
      await get(harness.door);
      expect(warned.filter((line) => line.includes("/nonexistent-host-root/package.json"))).toHaveLength(1);
    } finally {
      cwd.mockRestore();
      spy.mockRestore();
    }
  });

  it("is GET-only and 404s every other method", async () => {
    const response = await makeHarness().door.handler(new Request(`${BASE}/connect`, { method: "POST" }));
    expect(response.status).toBe(404);
  });
});

describe("createMcpDoor tool menu, titles, and annotations", () => {
  const surfaceDescriptors = [
    { name: "host_pay", description: "Pay a payee", inputSchema: { type: "object" }, risk: "write" as const, title: "Send payment" },
    { name: "host_wipe", description: "Delete everything", inputSchema: { type: "object" }, risk: "destructive" as const },
    { name: "host_admin", description: "Operator console", inputSchema: { type: "object" }, risk: "read" as const },
  ];

  async function open(options: HarnessOptions) {
    const harness = makeHarness(options);
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const connected = await connect(harness.door, tokens.access_token);
    return { harness, connected };
  }

  it("carries the human title in both standard places and risk-derived annotations on every tool", async () => {
    const { connected } = await open({ extraDescriptors: surfaceDescriptors });
    const listed = await connected.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    // read
    expect(byName.get("host_lookup")).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(byName.get("host_lookup")!.title).toBeUndefined();
    // write, titled — the label lands top-level (spec) AND on annotations
    // (where older clients still read it)
    expect(byName.get("host_pay")).toMatchObject({
      title: "Send payment",
      annotations: { title: "Send payment", readOnlyHint: false, destructiveHint: false },
    });
    // destructive
    expect(byName.get("host_wipe")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
    await connected.client.close();
  });

  it("says nothing about a tool NOBODY graded — an ungraded listing carries neither hint", async () => {
    const { connected } = await open({
      extraDescriptors: [
        { name: "host_maybe", description: "Nobody graded this", inputSchema: { type: "object" }, risk: "ungraded" as const, title: "Maybe" },
        { name: "host_unknown", description: "Nobody graded this either", inputSchema: { type: "object" }, risk: "ungraded" as const },
      ],
    });
    const listed = await connected.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    // MCP's default for `destructiveHint` is TRUE, so emitting `false` was an
    // active claim of safety about a tool nobody judged — and `true` would be
    // the opposite guess. Omitted, the client keeps its own conservative
    // default. `readOnlyHint: false` is the same unfounded claim, so it goes too.
    expect(byName.get("host_maybe")?.annotations).toEqual({ title: "Maybe" });
    expect(byName.get("host_unknown")?.annotations).toEqual({});
    await connected.client.close();
  });

  it("treats an empty title as no title (generated files can carry one; the wire must not)", async () => {
    const { connected } = await open({
      extraDescriptors: [
        { name: "host_blank", description: "Blank label", inputSchema: { type: "object" }, risk: "read" as const, title: "" },
      ],
    });
    const listed = await connected.client.listTools();
    const blank = listed.tools.find((tool) => tool.name === "host_blank")!;
    expect(blank.title).toBeUndefined();
    expect(blank.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    await connected.client.close();
  });

  it("lists only the configured menu, and a call to an off-menu tool is a plain not-found", async () => {
    const { harness, connected } = await open({
      extraDescriptors: surfaceDescriptors,
      menuTools: ["host_lookup", "host_pay"],
    });
    const listed = await connected.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["host_lookup", "host_pay"]);

    const before = harness.executions.length;
    const refused = await connected.client.callTool({ name: "host_admin", arguments: {} });
    expect(refused).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("not-found") }] });
    // Curation, not security: the tool never ran, and the answer is the SAME
    // in-band not-found an unknown name gets — the menu leaks nothing.
    expect(harness.executions.length).toBe(before);
    const unknown = await connected.client.callTool({ name: "host_nonexistent", arguments: {} });
    expect((refused.content as Array<{ text: string }>)[0]!.text.replace("host_admin", "X"))
      .toBe((unknown.content as Array<{ text: string }>)[0]!.text.replace("host_nonexistent", "X"));
    await connected.client.close();
  });

  it("never curates away Vendo's own apps ride-alongs, menu or no menu", async () => {
    const { connected } = await open({
      extraDescriptors: surfaceDescriptors,
      menuTools: ["host_pay"],
      apps: {
        async list() { return []; },
        async open() { return { kind: "tree" as const, payload: { formatVersion: "vendo-genui/v2", root: "root", nodes: [] } }; },
        async call() { return { status: "ok", output: {} }; },
      },
    });
    const listed = await connected.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "host_pay",
      "vendo_apps_list",
      "vendo_apps_open",
      "vendo_apps_call",
    ]);
    await connected.client.close();
  });

  it("re-resolves the menu per listing, so a lazily expanded tool becomes visible without a restart", async () => {
    // The registry GROWS mid-session (an `add()`), and
    // the umbrella's menu provider reads the registry. A door that resolved the
    // menu once would filter the late tool out forever.
    let expanded = false;
    const late = { name: "gmail_send", description: "Send mail", inputSchema: { type: "object" }, risk: "write" as const };
    const current = () => (expanded ? [...surfaceDescriptors, late] : surfaceDescriptors);
    const { connected } = await open({
      extraDescriptors: current,
      menuTools: () => ["host_lookup", ...current().map((tool) => tool.name)],
    });

    expect((await connected.client.listTools()).tools.map((tool) => tool.name)).not.toContain("gmail_send");
    expanded = true;
    expect((await connected.client.listTools()).tools.map((tool) => tool.name)).toContain("gmail_send");
    await connected.client.close();
  });

  it("re-resolves the menu per call, so a lazily expanded tool is callable without a restart", async () => {
    let expanded = false;
    const late = { name: "gmail_send", description: "Send mail", inputSchema: { type: "object" }, risk: "write" as const };
    const current = () => (expanded ? [...surfaceDescriptors, late] : surfaceDescriptors);
    const { harness, connected } = await open({
      extraDescriptors: current,
      menuTools: () => ["host_lookup", ...current().map((tool) => tool.name)],
    });

    await connected.client.listTools();
    expanded = true;
    const before = harness.executions.length;
    const called = await connected.client.callTool({ name: "gmail_send", arguments: {} });
    expect(called.isError).toBeFalsy();
    expect(harness.executions.length).toBe(before + 1);
    await connected.client.close();
  });

  it("never caches a failed menu resolution", async () => {
    let attempt = 0;
    const { connected } = await open({
      extraDescriptors: surfaceDescriptors,
      menuTools: () => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("overrides.json unreadable this once"));
        return Promise.resolve(["host_pay"]);
      },
    });
    await expect(connected.client.listTools()).rejects.toThrow();
    // A transient failure must not freeze the door into a permanently broken
    // (or permanently unrestricted) menu.
    expect((await connected.client.listTools()).tools.map((tool) => tool.name)).toEqual(["host_pay"]);
    await connected.client.close();
  });

  it("lists the whole surface when no menu is configured", async () => {
    const { connected } = await open({ extraDescriptors: surfaceDescriptors });
    const listed = await connected.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["host_lookup", "host_pay", "host_wipe", "host_admin"]);
    await connected.client.close();
  });

  it("never offers a withheld tool — not even a vendo_ one the menu can never curate away", async () => {
    // The prefix bypass exists so a host's curated menu cannot delete Vendo's
    // own plumbing. `withholdTools` is the deployment's own decision about ITS
    // door, so it is checked FIRST — otherwise it could hold back everything
    // except the tools it most needs to.
    const { connected } = await open({
      extraDescriptors: [
        ...surfaceDescriptors,
        { name: "vendo_make", description: "Make a screen", inputSchema: { type: "object" }, risk: "read" as const },
        { name: "vendo_apps_pin", description: "Pin an app", inputSchema: { type: "object" }, risk: "write" as const },
      ],
      withholdTools: ["vendo_apps_pin", "host_admin"],
    });

    const listed = (await connected.client.listTools()).tools.map((tool) => tool.name);
    expect(listed).not.toContain("vendo_apps_pin");
    expect(listed).not.toContain("host_admin");
    expect(listed).toContain("vendo_make");
    expect(listed).toContain("host_lookup");
    await connected.client.close();
  });

  it("answers a call to a withheld tool with the same in-band not-found an unknown name gets", async () => {
    const { harness, connected } = await open({
      extraDescriptors: [
        { name: "vendo_apps_pin", description: "Pin an app", inputSchema: { type: "object" }, risk: "write" as const },
      ],
      withholdTools: ["vendo_apps_pin"],
    });

    const before = harness.executions.length;
    const refused = await connected.client.callTool({ name: "vendo_apps_pin", arguments: {} });
    expect(refused).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("not-found") }],
    });
    // Not offered means not callable: the tool never ran.
    expect(harness.executions.length).toBe(before);
    await connected.client.close();
  });

  it("withholds an apps ride-along by name, so the apps path is not a way around it", async () => {
    const { connected } = await open({
      withholdTools: ["vendo_apps_call"],
      apps: {
        async list() { return []; },
        async open() { return { kind: "tree" as const, payload: { formatVersion: "vendo-genui/v2", root: "root", nodes: [] } }; },
        async call() { return { status: "ok", output: {} }; },
      },
    });

    const listed = (await connected.client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toContain("vendo_apps_list");
    expect(listed).toContain("vendo_apps_open");
    expect(listed).not.toContain("vendo_apps_call");
    const refused = await connected.client.callTool({ name: "vendo_apps_call", arguments: {} });
    expect(refused).toMatchObject({ isError: true });
    await connected.client.close();
  });
});

/**
 * D5's declared result shape, measured against what the OFFICIAL client actually
 * does with it: `tools/list` is parsed with the SDK's own `ToolSchema` (one bad
 * schema rejects the WHOLE listing) and `tools/call` THROWS on any non-`isError`
 * result whose `structuredContent` is missing or fails the advertised schema.
 * Every assertion here therefore goes through the real SDK client.
 */
describe("createMcpDoor declared output schemas on the wire", () => {
  /** The shape a generated tools.json really carries: named fields, plus a
   *  `required` and a closed `additionalProperties` the door cannot honour. */
  const declared = {
    type: "object",
    properties: {
      rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
      total: { type: "integer" },
    },
    required: ["rows", "total"],
    additionalProperties: false,
  };

  /** A marker no other schema in this file carries, so the door's compile cache
   *  (module-level, and warm from the tests above) is guaranteed to miss it. */
  const COMPILE_PROBE = "compile-cache probe";

  const declaring = (name: string, outputSchema: Record<string, unknown>) => ({
    name,
    description: `the ${name} tool`,
    inputSchema: { type: "object", properties: {} },
    outputSchema,
    risk: "read" as const,
  });

  async function open(options: HarnessOptions) {
    const harness = makeHarness(options);
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    return { harness, connected: await connect(harness.door, tokens.access_token) };
  }

  it("keeps the declared fields and types, and drops only what it cannot enforce", async () => {
    const { connected } = await open({ extraDescriptors: [declaring("host_report", declared)] });
    const listed = await connected.client.listTools();
    expect(listed.tools.find((tool) => tool.name === "host_report")?.outputSchema).toEqual({
      // The field names and types are the whole of D5's value to the model, and
      // they survive verbatim...
      type: "object",
      properties: declared.properties,
      // ...while `required` and a closed `additionalProperties` do not: the
      // client validates EVERY ok result against this, and the door has to be
      // able to return results the host never declared.
      additionalProperties: true,
    });
    await connected.client.close();
  });

  it("drops every top-level keyword that could REJECT a result the door has no choice about", async () => {
    // Each of these was measured against the official client's own validator: a
    // required nested in `allOf`, a `maxProperties` and a `not` each turned a
    // served result into a client throw. `properties` and `type` survive; the
    // power to reject does not.
    const hostile = {
      type: "object",
      properties: { rows: { type: "array" }, nested: { type: "object", required: ["id"] } },
      allOf: [{ required: ["rows"] }],
      anyOf: [{ required: ["rows"] }],
      maxProperties: 2,
      minProperties: 2,
      not: { properties: { rows: { const: null } } },
      if: { required: ["rows"] },
      then: { required: ["total"] },
      propertyNames: { pattern: "^[a-z]+$" },
      dependentRequired: { rows: ["total"] },
      unevaluatedProperties: false,
    };
    const { connected } = await open({ extraDescriptors: [declaring("host_report", hostile)] });
    const listed = await connected.client.listTools();
    expect(listed.tools.find((tool) => tool.name === "host_report")?.outputSchema).toEqual({
      type: "object",
      // A NESTED `required` survives deliberately: it constrains the value of a
      // field the host declared, so it can only reject the host's own result —
      // never a reserved-key envelope, whose keys no host schema mentions.
      properties: hostile.properties,
      additionalProperties: true,
    });
    await connected.client.close();
  });

  it("drops the two keywords that reject a key without ever NAMING one", async () => {
    // Round 5, both proven against the SDK's own validator before the fix.
    // `patternProperties` types keys by REGEX, so "^vendo" type-rejected
    // `vendo_truncated: true` (and "^.*$" would have taken `vendo_value` too) —
    // no reserved-name check could see it, because the name is never written.
    const patterned = {
      type: "object",
      properties: { answer: { type: "string" } },
      patternProperties: { "^vendo": { type: "string" } },
    };
    // A top-level `$ref` reaches AROUND the strip: the `required` and the closed
    // `additionalProperties` live in `$defs`, where deleting top-level keywords
    // never looks, and both envelopes failed. Not reachable from the shipped
    // OpenAPI extractor (it inlines refs) — a hand-written outputSchema is.
    const referencing = {
      type: "object",
      $ref: "#/$defs/Row",
      $defs: { Row: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } } },
    };
    const { connected } = await open({
      extraDescriptors: [declaring("host_patterned", patterned), declaring("host_referencing", referencing)],
      getOutcome: (call) => call.tool === "host_patterned"
        ? { status: "ok", output: { vendo_truncated: true, vendo_chars: 91_000, vendo_preview: "{\"answer\"" } }
        : { status: "ok", output: "just text" },
    });

    const listed = await connected.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("host_patterned")?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "string" } },
      additionalProperties: true,
    });
    // `$defs` stays: an unreferenced definition constrains nothing, and the door
    // only removes what can reject.
    expect(byName.get("host_referencing")?.outputSchema).toEqual({
      type: "object",
      $defs: referencing.$defs,
      additionalProperties: true,
    });

    // The proof: the client compiled both advertised schemas and validates every
    // ok result against them, so a kept keyword would throw right here.
    const truncated = await connected.client.callTool({ name: "host_patterned", arguments: {} });
    expect(truncated.isError).toBeFalsy();
    expect(truncated.structuredContent).toMatchObject({ vendo_truncated: true });
    const wrapped = await connected.client.callTool({ name: "host_referencing", arguments: {} });
    expect(wrapped.isError).toBeFalsy();
    expect(wrapped.structuredContent).toEqual({ vendo_value: "just text" });
    await connected.client.close();
  });

  it("drops the two keywords that pin the WHOLE object, which the strip above them cannot reach", async () => {
    // Round 6: `const` and `enum` do not reject a KEY, they reject the object,
    // so deleting `required`/`additionalProperties` around them changed nothing —
    // both envelopes came back "must be equal to constant"/"one of the allowed
    // values" from the client's own validator. The last two of this family: a
    // swept Ajv run cleared bare `$defs`, `definitions`, `$recursiveRef` and a
    // nested `required`.
    const pinned = {
      type: "object",
      properties: { id: { type: "string" } },
      const: { id: "x" },
    };
    const listed_ = {
      type: "object",
      properties: { id: { type: "string" } },
      enum: [{ id: "x" }, { id: "y" }],
    };
    const { connected } = await open({
      extraDescriptors: [declaring("host_pinned", pinned), declaring("host_listed", listed_)],
      getOutcome: (call) => call.tool === "host_pinned"
        ? { status: "ok", output: { vendo_truncated: true, vendo_chars: 91_000, vendo_preview: "{\"id\"" } }
        : { status: "ok", output: "just text" },
    });

    const listed = await connected.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    for (const name of ["host_pinned", "host_listed"]) {
      expect(byName.get(name)?.outputSchema, name).toEqual({
        type: "object",
        properties: { id: { type: "string" } },
        additionalProperties: true,
      });
    }

    // The proof: the client compiled both advertised schemas and validates every
    // ok result against them, so a kept keyword throws right here.
    const truncated = await connected.client.callTool({ name: "host_pinned", arguments: {} });
    expect(truncated.isError).toBeFalsy();
    expect(truncated.structuredContent).toMatchObject({ vendo_truncated: true });
    const wrapped = await connected.client.callTool({ name: "host_listed", arguments: {} });
    expect(wrapped.isError).toBeFalsy();
    expect(wrapped.structuredContent).toEqual({ vendo_value: "just text" });
    await connected.client.close();
  });

  it("a TRUNCATED ok output validates even against a schema built to reject it", async () => {
    // Exactly what `toolOutputCap` substitutes for a large output (agent/tools.ts
    // capOutcome) — a shape no host schema mentions. Against the unsanitized
    // schema the client threw "Structured content does not match the tool's
    // output schema" and the model never saw its answer. Every rejecting path the
    // AI review PROVED, in one schema: allOf-required, maxProperties, not, and a
    // declared property whose name collides with a reserved envelope key.
    const envelope = {
      vendo_truncated: true,
      vendo_chars: 91_000,
      vendo_preview: '{"rows":[{"id":"a"}',
    };
    const hostile = {
      type: "object",
      properties: { rows: { type: "array" }, vendo_preview: { type: "object" } },
      allOf: [{ required: ["rows"] }],
      maxProperties: 1,
      not: { properties: { vendo_truncated: { const: true } } },
    };
    const { connected } = await open({
      extraDescriptors: [declaring("host_report", hostile)],
      getOutcome: () => ({ status: "ok", output: envelope }),
    });
    const listed = await connected.client.listTools();
    // The colliding declaration is gone from the wire, so the reserved key falls
    // under the open `additionalProperties` instead of being type-checked.
    expect(listed.tools.find((tool) => tool.name === "host_report")?.outputSchema).toEqual({
      type: "object",
      properties: { rows: { type: "array" } },
      additionalProperties: true,
    });

    const result = await connected.client.callTool({ name: "host_report", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(envelope);
    await connected.client.close();
  });

  it("wraps EVERY non-record ok output under the reserved key, declared or not", async () => {
    // A declaring tool that answered with a bare string carried no
    // structuredContent at all, and the client threw on the RESULT: "has an
    // output schema but did not return structured content". The door no longer
    // asks WHETHER the tool declared one — the client compiles no validator for an
    // undeclared tool, so the extra key is invisible there, and asking cost a
    // `tools/list` after the write had already executed.
    const { connected } = await open({
      extraDescriptors: [declaring("host_report", declared)],
      getOutcome: (call) => ({
        status: "ok",
        output: call.tool === "host_report" ? "just text" : ["a", "b"],
      }),
    });
    await connected.client.listTools();

    const declaringCall = await connected.client.callTool({ name: "host_report", arguments: {} });
    expect(declaringCall.isError).toBeFalsy();
    expect(declaringCall.structuredContent).toEqual({ vendo_value: "just text" });
    expect(textOf(declaringCall)).toBe('"just text"');

    // host_lookup declares no output shape; the same wrapper rides anyway, and
    // the client accepts it because it has no schema to check it against.
    const undeclared = await connected.client.callTool({ name: "host_lookup", arguments: {} });
    expect(undeclared.isError).toBeFalsy();
    expect(undeclared.structuredContent).toEqual({ vendo_value: ["a", "b"] });
    expect(textOf(undeclared)).toBe('["a","b"]');
    await connected.client.close();
  });

  it("an unstatable host schema costs that ONE tool its schema, never the whole listing", async () => {
    const { connected } = await open({
      extraDescriptors: [
        declaring("host_report", declared),
        // A boolean subschema is LEGAL JSON Schema 2020-12 and still unstatable:
        // the client asserts every `properties` value is an object.
        declaring("host_bool_property", { type: "object", properties: { anything: true } }),
        // A top-level array — ordinary in an OpenAPI response spec.
        declaring("host_array", { type: "array", items: { type: "string" } }),
        // Past the serialized-size cap.
        declaring("host_huge", { type: "object", properties: hugeProperties() }),
        // WELL-SHAPED and still fatal: the client COMPILES every advertised
        // schema (`cacheToolMetadata`, run on each successful listTools), and a
        // compile throw rejects the whole listing. A dangling $ref is what
        // extraction leaves for a recursive response model with no $defs on the
        // wire; `type: "bogus"` and Swagger 2.0's boolean exclusiveMinimum are
        // the other two the AI review proved.
        declaring("host_dangling_ref", {
          type: "object",
          properties: { id: { type: "string" }, parent: { $ref: "#/components/schemas/Account" } },
        }),
        declaring("host_bogus_type", { type: "object", properties: { x: { type: "bogus" } } }),
        // Why the door asks the VALIDATOR rather than eyeballing the shape: a
        // Python-style named group is ordinary in a generated OpenAPI spec and is
        // a compile throw no hand-written check would ever have listed.
        declaring("host_bad_pattern", {
          type: "object",
          properties: { id: { type: "string", pattern: "(?P<year>\\d{4})" } },
        }),
        declaring("host_draft4_bounds", {
          type: "object",
          properties: { n: { type: "number", minimum: 0, exclusiveMinimum: true } },
        }),
        // A schema that cannot even be serialized: an OpenAPI model inlined into
        // itself. `JSON.stringify` threw inside the listing map.
        declaring("host_cyclic", cyclicSchema()),
      ],
    });

    // The listing PARSES — which is the finding: any one of these used to reject
    // the whole tools/list result and leave the client with no tools at all.
    const listed = await connected.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()]).toEqual([
      "host_lookup",
      "host_report",
      "host_bool_property",
      "host_array",
      "host_huge",
      "host_dangling_ref",
      "host_bogus_type",
      "host_bad_pattern",
      "host_draft4_bounds",
      "host_cyclic",
    ]);
    expect(byName.get("host_report")?.outputSchema).toBeDefined();
    for (const name of [
      "host_bool_property",
      "host_array",
      "host_huge",
      "host_dangling_ref",
      "host_bogus_type",
      "host_bad_pattern",
      "host_draft4_bounds",
      "host_cyclic",
    ]) {
      expect(byName.get(name), name).not.toHaveProperty("outputSchema");
    }
    await connected.client.close();
  });

  it("caps the schema by BYTES on the wire, not by UTF-16 units", async () => {
    // 20k CJK characters is 20k `.length` and ~60KB on the wire — the cap read
    // `.length` and shipped it, ~3x over. Its ASCII twin of the same `.length`
    // is genuinely small and keeps its schema, so this measures the COUNTING,
    // not the cap.
    const label = (character: string) => ({
      type: "object",
      properties: { note: { type: "string", description: character.repeat(20_000) } },
    });
    const { connected } = await open({
      extraDescriptors: [declaring("host_cjk", label("経")), declaring("host_ascii", label("a"))],
    });
    const listed = await connected.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("host_cjk")).not.toHaveProperty("outputSchema");
    expect(byName.get("host_ascii")?.outputSchema).toBeDefined();
    await connected.client.close();
  });

  it("compiles a given schema ONCE, however many listings advertise it", async () => {
    // Compiling is the expensive half of a listing and it is pure: 244ms for 35
    // schemas, 1370ms for 301 (measured 2026-08-03), paid AGAIN on every
    // `tools/list` — and this redesign re-lists on every `list_changed`. The
    // verdict is cached on the serialized schema the pass already computes.
    //
    // Driven over raw JSON-RPC on purpose: the SDK client compiles every
    // advertised schema too (`cacheToolMetadata`), and a counter that saw both
    // sides could not say which one recompiled.
    const probe = { type: "object", properties: { note: { type: "string", description: COMPILE_PROBE } } };
    const harness = makeHarness({ extraDescriptors: [declaring("host_probe", probe)] });
    const registration = await register(harness.door);
    const tokens = await issue(harness.door, registration.body.client_id);
    const getValidator = vi.spyOn(AjvJsonSchemaValidator.prototype, "getValidator");
    const compiles = () => getValidator.mock.calls
      .filter(([schema]) => JSON.stringify(schema).includes(COMPILE_PROBE)).length;
    try {
      const initialized = await harness.door.handler(mcpRequest(tokens.access_token));
      const sessionId = initialized.headers.get("mcp-session-id")!;
      const list = async () => {
        const response = await harness.door.handler(mcpRequest(tokens.access_token, sessionId));
        expect(response.status).toBe(200);
        return await response.text();
      };

      expect(await list()).toContain(COMPILE_PROBE);
      expect(compiles()).toBe(1);
      // The second listing still ADVERTISES the schema — the cached verdict is an
      // answer, not a skip — and costs no compile.
      expect(await list()).toContain(COMPILE_PROBE);
      expect(compiles()).toBe(1);
    } finally {
      getValidator.mockRestore();
    }
  });

  it("a malformed `required` no longer costs the tool its fields — it is dropped either way", async () => {
    // `required: "id"` used to reject the whole schema, because the wire carried
    // `required` and the client's ToolSchema wants an array. Nothing enforceable
    // reaches the wire now, so the model still learns the field names.
    const { connected } = await open({
      extraDescriptors: [
        declaring("host_bad_required", { type: "object", properties: { id: { type: "string" } }, required: "id" }),
      ],
    });
    const listed = await connected.client.listTools();
    expect(listed.tools.find((tool) => tool.name === "host_bad_required")?.outputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: true,
    });
    await connected.client.close();
  });
});

/**
 * 10-mcp §3b — the TURN path's results, measured through the real client.
 *
 * The door used to re-fetch the turn's listing after execution to decide whether
 * to attach `structuredContent`. That question is now answered without asking:
 * the wrapper rides unconditionally, so an already-committed write can never be
 * turned into an error by a listing that throws.
 */
describe("createMcpDoor turn-credential results", () => {
  const TOKEN = "vtk_live_turn";

  function liveTurn(output: Json, onList: () => void) {
    return {
      ctx: { principal: { kind: "user" as const, subject: "user_1" }, venue: "chat" as const, presence: "present" as const, sessionId: "turn_session_1" },
      tools: {
        async call() {
          return { status: "ok" as const, output };
        },
        async list() {
          onList();
          return [{
            name: "host_lookup",
            title: "Look something up",
            description: "Look something up",
            risk: "read" as const,
            inputSchema: { type: "object", properties: {} },
            outputSchema: { type: "object", properties: { rows: { type: "array" } }, required: ["rows"] },
          }];
        },
      },
    };
  }

  it("wraps a non-record ok output with NO tools/list in the call path", async () => {
    const lists: number[] = [];
    const harness = makeHarness({
      turnCredentials: {
        async resolve(token) {
          return token === TOKEN ? liveTurn("just text", () => lists.push(1)) : null;
        },
      },
    });
    const connected = await connect(harness.door, TOKEN);

    const listed = await connected.client.listTools();
    expect(listed.tools[0]?.outputSchema).toEqual({
      type: "object",
      properties: { rows: { type: "array" } },
      additionalProperties: true,
    });
    expect(lists.length).toBe(1);

    // The tool declared a schema and answered with a bare string: without a
    // wrapper the client throws "did not return structured content", and the
    // model reads a completed call as a broken server.
    const result = await connected.client.callTool({ name: "host_lookup", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ vendo_value: "just text" });
    // The listing is not consulted by the call path at all — which is the fix:
    // it ran AFTER the write, unguarded.
    expect(lists.length).toBe(1);
    await connected.client.close();
  });

  it("grades the LIVE-TURN listing by the same rule — ungraded says nothing there either", async () => {
    // The turn surface is a second place that builds MCP `Tool` objects, so a
    // claim deleted from the OAuth listing has to be deleted here too or the two
    // drift and a claudeCode() box reads the guess the outside agent no longer does.
    const harness = makeHarness({
      turnCredentials: {
        async resolve(token) {
          if (token !== TOKEN) return null;
          const turn = liveTurn("x", () => {});
          return {
            ...turn,
            tools: {
              ...turn.tools,
              list: async () => [
                { name: "host_lookup", description: "Look something up", risk: "read" as const, inputSchema: { type: "object", properties: {} } },
                { name: "host_wipe", description: "Delete everything", risk: "destructive" as const, inputSchema: { type: "object", properties: {} } },
                { name: "host_maybe", description: "Nobody graded this", risk: "ungraded" as const, inputSchema: { type: "object", properties: {} } },
              ] as Omit<ToolListing, "title">[] as ToolListing[],
            },
          };
        },
      },
    });
    const connected = await connect(harness.door, TOKEN);
    const listed = await connected.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    expect(byName.get("host_lookup")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("host_wipe")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get("host_maybe")?.annotations).toEqual({});
    await connected.client.close();
  });

  it("still answers when the turn's listing THROWS after the write", async () => {
    const harness = makeHarness({
      turnCredentials: {
        async resolve(token) {
          if (token !== TOKEN) return null;
          const turn = liveTurn(["a", "b"], () => {});
          return { ...turn, tools: { ...turn.tools, list: async () => { throw new Error("turn closed"); } } };
        },
      },
    });
    const connected = await connect(harness.door, TOKEN);
    const result = await connected.client.callTool({ name: "host_lookup", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ vendo_value: ["a", "b"] });
    await connected.client.close();
  });
});

/**
 * ADVERSARIAL: `withholdTools` on the TURN-bearing leg (risk round, 2026-08-06).
 *
 * `withholdTools` is documented as "names this door NEVER offers, whatever else
 * says otherwise" and as "what THIS door, as deployed, does not do" — a
 * deployment fact, not a menu fact, which is why it is checked ahead of the
 * `vendo_` prefix bypass.
 *
 * A door with `turnCredentials` (every `createVendo({ mcp: true })` composition
 * has them — server.ts passes them to the outside door too) has a SECOND
 * credential space on the SAME mount. `#handleMcp` resolves a turn bearer
 * before anything else, and from there `#registerHandlers` lists
 * `turnTools(state.turn)` and `#callTool` hands the name straight to
 * `turn.tools.call` — neither consults `#withheld`. So a name this deployment
 * said it does not do is both advertised and callable on the other leg of the
 * same door.
 */
describe("createMcpDoor withholdTools on a turn-bearing session", () => {
  const TOKEN = "vtk_withhold_turn";
  const WITHHELD = "vendo_apps_pin";

  function harnessFor(calls: string[]) {
    return makeHarness({
      withholdTools: [WITHHELD],
      turnCredentials: {
        async resolve(token) {
          if (token !== TOKEN) return null;
          return {
            ctx: {
              principal: { kind: "user" as const, subject: "user_1" },
              venue: "chat" as const,
              presence: "present" as const,
              sessionId: "turn_session_1",
            },
            tools: {
              async call(name: string) {
                calls.push(name);
                return { status: "ok" as const, output: { placed: true } };
              },
              async list() {
                return [
                  { name: "host_lookup", description: "Look something up", risk: "read" as const, inputSchema: { type: "object", properties: {} } },
                  { name: WITHHELD, description: "Pin an app", risk: "write" as const, inputSchema: { type: "object", properties: {} } },
                ] as Omit<ToolListing, "title">[] as ToolListing[];
              },
            },
          };
        },
      },
    });
  }

  it("does not advertise the withheld name to a live turn either", async () => {
    const connected = await connect(harnessFor([]).door, TOKEN);

    const listed = (await connected.client.listTools()).tools.map((tool) => tool.name);

    expect(listed).toContain("host_lookup");
    expect(listed).not.toContain(WITHHELD);
    await connected.client.close();
  });

  it("refuses the withheld name on a turn-bearing call, as the OAuth leg does", async () => {
    const calls: string[] = [];
    const connected = await connect(harnessFor(calls).door, TOKEN);

    const refused = await connected.client.callTool({ name: WITHHELD, arguments: { app: "app_1", slot: "hero" } });

    expect(refused).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("not-found") }],
    });
    // Not offered has to mean not callable — on BOTH legs of one mount, or the
    // withhold is a listing cosmetic with a documented security posture.
    expect(calls).toEqual([]);
    await connected.client.close();
  });
});

describe("createMcpDoor MCP Apps on a turn-bearing session", () => {
  const TOKEN = "vtk_apps_turn";

  /** The umbrella composes ONE door with both `apps` and `turnCredentials`, and
   *  the turn's registry owns `vendo_apps_open` (apps.agentTools). Whatever the
   *  OAuth leg does to make an app render, this leg has to do too — it is the
   *  same mount and the same feature. */
  function harnessFor(payload: Record<string, unknown>) {
    const apps: AppsRideAlong = {
      async list() { return []; },
      async open() { return { kind: "http", url: "https://app.example" }; },
      async call() { return { status: "ok", output: null }; },
    };
    return makeHarness({
      apps,
      turnCredentials: {
        async resolve(token) {
          if (token !== TOKEN) return null;
          return {
            ctx: {
              principal: { kind: "user" as const, subject: "user_1" },
              venue: "chat" as const,
              presence: "present" as const,
              sessionId: "turn_session_1",
            },
            tools: {
              async call() {
                return { status: "ok" as const, output: { kind: "tree", payload } };
              },
              async list() {
                return [
                  { name: "host_lookup", description: "Look something up", risk: "read" as const, inputSchema: { type: "object", properties: {} } },
                  { name: "vendo_apps_open", description: "Open a saved app", risk: "read" as const, inputSchema: { type: "object", properties: {} } },
                ] as Omit<ToolListing, "title">[] as ToolListing[];
              },
            },
          };
        },
      },
    });
  }

  it("advertises the shim on the turn leg's apps listing", async () => {
    const connected = await connect(harnessFor({}).door, TOKEN);

    const listed = (await connected.client.listTools()).tools;
    expect(listed.find((tool) => tool.name === "vendo_apps_open")?._meta).toEqual({
      ui: { resourceUri: "ui://vendo/tree-shim.html" },
      "ui/resourceUri": "ui://vendo/tree-shim.html",
    });
    // Only the app-viewer names get it; a host tool is untouched.
    expect(listed.find((tool) => tool.name === "host_lookup")?._meta).toBeUndefined();
    await connected.client.close();
  });

  it("unwraps the OpenSurface envelope and strips the already-resolved queries", async () => {
    const payload = {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [],
      data: { via: "turn" },
      queries: [{ name: "via", tool: "host_source" }],
    };
    const connected = await connect(harnessFor(payload).door, TOKEN);

    const result = await connected.client.callTool({ name: "vendo_apps_open", arguments: { appId: "app_1" } });

    // The shim renders a bare format-tagged UIPayload, and the turn's runtime
    // already resolved every query into `data` — forwarding the declarations
    // would execute them a second time.
    expect(result.structuredContent).toEqual({
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [],
      data: { via: "turn" },
    });
    await connected.client.close();
  });
});

describe("createMcpDoor first-party service auth", () => {
  const AS_URL = "https://product.example/.well-known/oauth-authorization-server/api/vendo/mcp";

  it("exchanges a key and a user id for a short-lived token that works on a real tools/call", async () => {
    const harness = makeHarness({ serviceAuth: { keys: [SERVICE_KEY] } });

    const response = await serviceExchange(harness.door);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as TokenResponse & { issued_token_type: string };
    expect(body.access_token).toMatch(/^vmat_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 600,
      scope: "read write",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
    // No refresh token — and none of the machinery behind one. A backend that
    // holds the key exchanges again; there is nothing outstanding to rotate.
    expect(Object.keys(body).sort()).toEqual([
      "access_token", "expires_in", "issued_token_type", "scope", "token_type",
    ]);
    const grants = harness.store.rows("vendo_mcp_grants");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.data).toMatchObject({
      kind: "access",
      subject: "user_1",
      clientId: SERVICE_CLIENT,
      resource: BASE,
      scopes: ["read", "write"],
    });
    const expiresAt = Date.parse((grants[0]!.data as { expiresAt: string }).expiresAt);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
    expect(JSON.stringify(grants)).not.toContain(body.access_token);
    expect(JSON.stringify(grants)).not.toContain(SERVICE_KEY);
    expect(harness.audits.at(-1)).toMatchObject({
      kind: "door-auth",
      detail: { clientId: SERVICE_CLIENT, event: "exchange" },
    });

    const connected = await connect(harness.door, body.access_token);
    const result = await connected.client.callTool({ name: "host_lookup", arguments: { query: "balance" } });
    expect(textOf(result)).toContain("42");
    // The service key is the CLIENT on every row the call leaves behind.
    expect((harness.executions[0]?.ctx as { mcpConsent?: unknown }).mcpConsent).toEqual({
      clientId: SERVICE_CLIENT,
      scopes: ["read", "write"],
    });
    await connected.client.close();
  });

  it("answers every bad exchange with one OAuth error, and never says which key exists", async () => {
    const harness = makeHarness({ serviceAuth: { keys: [SERVICE_KEY] } });
    const rows: Array<[string, Record<string, string | null>, string]> = [
      ["an unknown key", { client_secret: SERVICE_KEY_B }, "invalid_client"],
      ["a string that is not a key at all", { client_secret: "not-a-service-key" }, "invalid_client"],
      ["a near miss on a listed key", { client_secret: `${SERVICE_KEY}x` }, "invalid_client"],
      ["another client_id", { client_id: "mcpc_000000000000" }, "invalid_client"],
      ["no client_secret", { client_secret: null }, "invalid_request"],
      ["no subject_token", { subject_token: null }, "invalid_request"],
      ["an empty subject_token", { subject_token: "" }, "invalid_request"],
      ["no subject_token_type", { subject_token_type: null }, "invalid_request"],
      ["a subject_token_type this door does not speak", { subject_token_type: "urn:ietf:params:oauth:token-type:jwt" }, "invalid_request"],
      ["another server's resource", { resource: "https://other.example/mcp" }, "invalid_target"],
      ["a grant_type nobody serves", { grant_type: "client_credentials" }, "unsupported_grant_type"],
    ];
    const refusals: string[] = [];
    for (const [name, overrides, error] of rows) {
      const response = await serviceExchange(harness.door, overrides);
      expect(response.status, name).toBe(400);
      const body = await response.json() as { error: string };
      expect(body, name).toMatchObject({ error });
      if (error === "invalid_client") refusals.push(JSON.stringify(body));
    }
    // Indistinguishable is the whole claim, and the `error` code alone does not
    // carry it: a description that named the failing half would be an oracle
    // while every assertion above still passed. The BODIES must be identical.
    expect(new Set(refusals).size, refusals.join("\n")).toBe(1);

    const wrongType = await serviceExchange(harness.door, {}, "application/json");
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toMatchObject({ error: "invalid_request" });

    // Nothing was minted and nothing was audited along the way.
    expect(harness.store.rows("vendo_mcp_grants")).toEqual([]);
    expect(harness.audits).toEqual([]);
  });

  it("serves both keys through a rotation, and refuses one the door no longer lists", async () => {
    const rotating = makeHarness({ serviceAuth: { keys: [SERVICE_KEY, SERVICE_KEY_B] } });
    for (const [key, client] of [[SERVICE_KEY, SERVICE_CLIENT], [SERVICE_KEY_B, SERVICE_CLIENT_B]] as const) {
      expect((await serviceExchange(rotating.door, { client_secret: key })).status, key).toBe(200);
      // Each key wears its OWN label — the hash of the key that matched.
      expect(rotating.audits.at(-1), key).toMatchObject({ detail: { clientId: client, event: "exchange" } });
    }

    const retired = makeHarness({ serviceAuth: { keys: [SERVICE_KEY] } });
    const refused = await serviceExchange(retired.door, { client_secret: SERVICE_KEY_B });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_client" });
  });

  it("does not serve the grant at all on a door with no keys", async () => {
    const response = await serviceExchange(makeHarness().door);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("advertises the exchange and client_secret_post only when keys are configured", async () => {
    const off = await makeHarness().door.handler(new Request(AS_URL));
    expect(await off.json()).toMatchObject({
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    });

    const on = await makeHarness({ serviceAuth: { keys: [SERVICE_KEY] } }).door.handler(new Request(AS_URL));
    expect(await on.json()).toMatchObject({
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:token-exchange",
      ],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
  });

  it("refuses a key list that cannot ever match, LOUDLY, by index and never by value", () => {
    // A key the door can never match is not a security posture, it is a
    // deployment that advertises the grant and answers every exchange with
    // `invalid_client` — the most expensive possible way to learn about an unset
    // env var, which is the realistic spelling of the mistake.
    const bad: Array<[label: string, keys: readonly string[], names: RegExp]> = [
      // An empty list is the same failure with nothing to point at.
      ["an empty list", [], /serviceAuth\.keys is empty/],
      ["a hole where an env var should be", [undefined as unknown as string], /serviceAuth\.keys\[0\]/],
      ["a blank first entry", ["", SERVICE_KEY], /serviceAuth\.keys\[0\]/],
      // A good key beside a blank one still fails, and the message names WHICH
      // entry: a rotation list with a dead slot strands whoever holds that key.
      ["a dead slot in a rotation list", [SERVICE_KEY, "   "], /serviceAuth\.keys\[1\]/],
    ];
    for (const [label, keys, names] of bad) {
      expect(() => makeHarness({ serviceAuth: { keys } }), label).toThrow(names);
      // Every one of these lists still holds LIVE keys. Naming the index is
      // enough to fix the deployment; echoing a value writes a live credential
      // into whatever collects the crash.
      try {
        makeHarness({ serviceAuth: { keys } });
      } catch (error) {
        expect((error as Error).message, label).not.toContain(SERVICE_KEY);
        expect((error as Error).message, label).not.toContain(SERVICE_KEY.slice(13));
      }
    }
    // Anything non-empty is a key. There is no shape to get wrong.
    expect(() => makeHarness({ serviceAuth: { keys: ["not-a-service-key"] } })).not.toThrow();
  });
});

/** A host response model that references itself by OBJECT — what an inliner
 *  produces for a recursive OpenAPI model. `JSON.stringify` throws on it. */
function cyclicSchema(): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: "object", properties: {} };
  (schema.properties as Record<string, unknown>).parent = schema;
  return schema;
}

/** Comfortably past the door's ~32KiB serialized-schema cap. */
function hugeProperties(): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: 800 }, (_, index) => [
    `field_${index}`,
    { type: "string", description: "x".repeat(64) },
  ]));
}

interface HarnessOptions {
  store?: MemoryStore;
  menuTools?: string[] | (() => string[] | undefined | Promise<string[] | undefined>);
  /** 10-mcp — names this door never offers, whatever the menu says. */
  withholdTools?: string[];
  productName?: string;
  state?: McpDoorState;
  /** The call is passed so one harness can answer several tools differently. */
  getOutcome?: (call: ToolCall) => ToolOutcome;
  principal?: (subject: string) => Principal | null;
  apps?: AppsRideAlong;
  /** A function form lets a test GROW the surface mid-session, which is exactly
   *  what a memoized door menu would miss. */
  extraDescriptors?:
    | Awaited<ReturnType<ToolRegistry["descriptors"]>>
    | (() => Awaited<ReturnType<ToolRegistry["descriptors"]>>);
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
  /** 10-mcp §3b — ask for a door that serves ONLY live turns. */
  internal?: boolean;
  /** Override the guard's audit sink (e.g. to simulate a failing store write). */
  report?: Guard["report"];
  /** Build contract §9.1 — the host's org query, keyed on Principal. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
  /** 10-mcp §3b — a live turn behind a per-turn bearer. */
  turnCredentials?: TurnCredentialPort;
  /** First-party service keys the door accepts at its token endpoint. */
  serviceAuth?: { keys: readonly string[] };
}

function makeHarness(options: HarnessOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const audits: AuditEvent[] = [];
  const authorizeContexts: Array<{ clientName: string; scopes: string[] }> = [];
  const principalSubjects: string[] = [];
  const executions: Array<{ id: string; ctx: Parameters<ToolRegistry["execute"]>[1] }> = [];
  const guard: Guard = {
    check: options.check ?? (async () => ({ action: "run", decidedBy: "default" })),
    report: options.report ?? (async (event) => { audits.push(event); }),
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
      }, ...(typeof options.extraDescriptors === "function" ? options.extraDescriptors() : options.extraDescriptors ?? [])];
    },
    async execute(call, ctx) {
      executions.push({ id: call.id, ctx });
      return options.getOutcome?.(call) ?? { status: "ok", output: { answer: 42 } };
    },
  };
  const config = {
    tools,
    guard,
    store,
    apps: options.apps,
    ...(options.menuTools === undefined ? {} : { menuTools: options.menuTools }),
    ...(options.withholdTools === undefined ? {} : { withholdTools: options.withholdTools }),
    ...(options.productName === undefined ? {} : { productName: options.productName }),
    ...(options.mount === undefined ? {} : { mount: options.mount }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.remoteAs === undefined ? {} : { remoteAs: options.remoteAs }),
    ...(options.federation === undefined ? {} : { federation: options.federation }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.memberships === undefined ? {} : { memberships: options.memberships }),
    ...(options.internal === undefined ? {} : { internal: options.internal }),
    ...(options.turnCredentials === undefined ? {} : { turnCredentials: options.turnCredentials }),
    ...(options.serviceAuth === undefined ? {} : { serviceAuth: options.serviceAuth }),
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

/** A valid service-key exchange at the token endpoint. An override of `null`
 *  DROPS that field, which is how the missing-field rows are driven. */
async function serviceExchange(
  door: McpDoor,
  overrides: Record<string, string | null> = {},
  contentType = "application/x-www-form-urlencoded",
) {
  const fields: Record<string, string | null> = {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: "vendo-service",
    client_secret: SERVICE_KEY,
    subject_token: "user_1",
    subject_token_type: "urn:vendo:params:oauth:token-type:user-id",
    resource: BASE,
    ...overrides,
  };
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) body.set(name, value);
  }
  return door.handler(new Request(`${BASE}/token`, { method: "POST", headers: { "content-type": contentType }, body }));
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

/** The standalone SSE stream a client opens for server-initiated notifications.
 *  `accept` is a parameter so a test can send the GET the transport REJECTS. */
function sseRequest(accessToken: string, sessionId: string, accept = "text/event-stream") {
  return new Request(BASE, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
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

async function generateSigningKey(kid: string, alg = "ES256") {
  const pair = await generateKeyPair(alg);
  return { ...pair, kid, alg };
}

async function mintRemoteToken(
  privateKey: CryptoKey,
  kid: string,
  options: { issuer: string; audience: string; alg?: string } & RemoteTokenOverrides,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({})
    .setProtectedHeader({ alg: options.alg ?? "ES256", kid })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setSubject(options.sub ?? "external_user")
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(privateKey);
}

async function remoteAsFixture(alg = "ES256") {
  const issuer = "https://as.example";
  const jwksUri = `${issuer}/jwks`;
  let key = await generateSigningKey("initial", alg);
  let jwks = { keys: [{ ...(await exportJWK(key.publicKey)), alg, use: "sig", kid: key.kid }] };
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
    publicJwk: async () => await exportJWK(key.publicKey),
    kid: () => key.kid,
    async mint(overrides: RemoteTokenOverrides = {}) {
      return mintRemoteToken(key.privateKey, key.kid, {
        issuer: overrides.issuer ?? issuer,
        audience: overrides.audience ?? BASE,
        alg,
        ...overrides,
      });
    },
    async rotate(kid: string) {
      key = await generateSigningKey(kid, alg);
      jwks = { keys: [{ ...(await exportJWK(key.publicKey)), alg, use: "sig", kid: key.kid }] };
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
