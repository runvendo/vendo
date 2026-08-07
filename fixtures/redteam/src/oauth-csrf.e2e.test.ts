/** OAuth + CSRF adversarial suite (ENG-251).
 *
 * The MCP door's OAuth server and the umbrella wire's CSRF floor are DEFENDED
 * (packages/mcp/src/oauth/server.ts, packages/vendo/src/server.ts) but the
 * red-team wave never attacked them on the composed system. These probes assert
 * each defense holds and would FAIL if the guard were removed:
 *
 *   - PKCE downgrade — authorize demanding code_challenge_method=S256; a `plain`
 *     or absent challenge is refused (no code minted).
 *   - redirect_uri manipulation — an unregistered redirect_uri is refused, and
 *     never redirected to (open-redirect / code-exfil).
 *   - cross-resource token substitution — a bearer minted for one MCP resource
 *     is rejected at a different resource (confused-deputy).
 *   - CSRF on the wire — the JSON-content-type mutation gate, the import
 *     media-type gate, and the __Host- prefixed anonymous cookie.
 *
 * The door is composed over the SAME real store + guard + bound registry a live
 * umbrella uses (createStack), and the wire is a real createVendo handler.
 */
import type { LanguageModel } from "ai";
import type { Principal } from "@vendoai/core";
import { createMcpDoor, type HostOAuthAdapter, type McpDoor } from "@vendoai/mcp";
import { createVendo } from "@vendoai/vendo/server";
import { afterEach, describe, expect, it } from "vitest";
import { createStack, type Stack } from "./harness.js";

const ORIGIN = "https://product.example";
const MOUNT = "/api/vendo/mcp";
const BASE = `${ORIGIN}${MOUNT}`;
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-test-suite-1234567890";

const stacks: Stack[] = [];
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.close();
});

async function doorOverStack(): Promise<McpDoor> {
  const stack = await createStack();
  stacks.push(stack);
  const oauth: HostOAuthAdapter = {
    async authorize() { return { subject: "user_ada" }; },
    async principal(subject: string): Promise<Principal> { return { kind: "user", subject }; },
  };
  return createMcpDoor({
    tools: stack.bound,
    guard: stack.guard,
    store: stack.store,
    oauth,
    mount: MOUNT,
  });
}

async function register(door: McpDoor): Promise<string> {
  const response = await door.handler(new Request(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Red-team client", redirect_uris: [REDIRECT], scope: "read write" }),
  }));
  return (await response.json() as { client_id: string }).client_id;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return Buffer.from(digest).toString("base64url");
}

async function authorize(door: McpDoor, clientId: string, overrides: Record<string, string> = {}): Promise<Response> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    scope: "read write",
    resource: BASE,
    ...overrides,
  });
  return door.handler(new Request(`${BASE}/authorize?${params}`));
}

async function codeFrom(door: McpDoor, clientId: string): Promise<string> {
  const auth = await authorize(door, clientId);
  return new URL(auth.headers.get("location")!).searchParams.get("code")!;
}

async function exchange(door: McpDoor, values: Record<string, string>): Promise<Response> {
  return door.handler(new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: REDIRECT, ...values }),
  }));
}

async function issueAccessToken(door: McpDoor, clientId: string): Promise<string> {
  const token = await exchange(door, {
    code: await codeFrom(door, clientId),
    client_id: clientId,
    code_verifier: VERIFIER,
    resource: BASE,
  });
  expect(token.status).toBe(200);
  return (await token.json() as { access_token: string }).access_token;
}

describe("MCP door OAuth — adversarial (ENG-251)", () => {
  it("refuses a PKCE downgrade: plain method, or a missing challenge, never mints a code", async () => {
    const door = await doorOverStack();
    const clientId = await register(door);

    const downgrades: Record<string, string>[] = [
      { code_challenge_method: "plain" }, // PKCE downgraded to plain
      { code_challenge_method: "S256", code_challenge: "" }, // challenge stripped
    ];
    for (const overrides of downgrades) {
      const response = await authorize(door, clientId, overrides);
      // The door redirects PKCE errors to the registered redirect_uri — with an
      // error, NEVER a code. Removing the S256 requirement would mint a code here.
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("code")).toBeNull();
    }
  });

  it("still enforces PKCE at the token endpoint (wrong verifier is invalid_grant)", async () => {
    const door = await doorOverStack();
    const clientId = await register(door);
    const response = await exchange(door, {
      code: await codeFrom(door, clientId),
      client_id: clientId,
      code_verifier: "the-attacker-does-not-know-the-real-verifier-000000000000",
      resource: BASE,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses an unregistered redirect_uri and never redirects to it (open-redirect / code exfil)", async () => {
    const door = await doorOverStack();
    const clientId = await register(door);
    const response = await authorize(door, clientId, { redirect_uri: "https://attacker.example/steal" });
    // A JSON 400 at the endpoint — the door will not 302 a code to an unregistered uri.
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refuses an authorize resource that does not identify this server (target confusion)", async () => {
    const door = await doorOverStack();
    const clientId = await register(door);
    const response = await authorize(door, clientId, { resource: "https://other.example/mcp", state: "s1" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_target");
    expect(location.searchParams.get("state")).toBe("s1");
  });

  it("rejects a bearer minted for one resource when presented at another (cross-resource substitution)", async () => {
    const door = await doorOverStack();
    const clientId = await register(door);
    const accessToken = await issueAccessToken(door, clientId);

    // Same door, different resource path → the token↔resource binding fails.
    const crossed = await door.handler(new Request(`${ORIGIN}/api/vendo/other-mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }));
    expect(crossed.status).toBe(401);

    // And a token-exchange whose resource param mismatches is invalid_target.
    const badResource = await exchange(door, {
      code: await codeFrom(door, clientId),
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: "https://other.example/mcp",
    });
    expect(await badResource.json()).toMatchObject({ error: "invalid_target" });
  });
});

describe("umbrella wire CSRF floor — adversarial (ENG-251)", () => {
  // A createVendo handler with an anonymous principal resolver. The model is
  // never reached: every probe below is rejected at the CSRF/cookie floor,
  // ahead of principal resolution and agent execution.
  const wire = () => createVendo({
    model: {} as unknown as LanguageModel,
    principal: async () => null,
  }).handler;

  it("rejects a state-changing POST that is not application/json (CSRF content-type gate)", async () => {
    const handler = wire();
    // A valid JSON body, but a simple (CORS-safelisted) content-type: a
    // cross-site form/text POST. The gate refuses it BEFORE the body is read, so
    // removing the gate would let this reach the agent instead of 400ing here.
    const response = await handler(new Request(`${ORIGIN}/api/vendo/threads`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ message: "hi" }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: "content-type must be application/json" } });
  });

  it("requires a non-safelisted media type for app import (forces a CORS preflight)", async () => {
    const handler = wire();
    const response = await handler(new Request(`${ORIGIN}/api/vendo/apps/import`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not an app",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "import requires Content-Type: application/octet-stream" },
    });
  });

  it("mints the anonymous session cookie with the __Host- prefix over https (fixation defense)", async () => {
    const handler = wire();
    const response = await handler(new Request(`${ORIGIN}/api/vendo/status`));
    const setCookie = response.headers.get("set-cookie") ?? "";
    // __Host- requires Secure + Path=/ + no Domain — a sibling subdomain cannot
    // plant it. Removing the prefix (or Secure) would regress session fixation.
    expect(setCookie).toContain("__Host-vendo_anon_session=");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");
  });
});
