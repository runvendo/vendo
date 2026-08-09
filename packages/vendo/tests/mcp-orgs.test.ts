import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_APP_FORMAT, type AppDocument, type Membership, type Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

/**
 * F4 (wave-3 independent check) — org and shared apps over MCP, through the
 * REAL composition (`createVendo` fills the door's seams itself), driven the way
 * an MCP client drives it: register, authorize, exchange, connect, call.
 *
 * `can()` reads the caller's orgs from the RunContext and never queries them
 * (§9.3), so a door that mints a ctx WITHOUT memberships can never match an
 * `org:`/`team:` grant. Kim's access below is a TEAM grant on purpose: a
 * `user:` grant would pass with or without the seam and would prove nothing.
 */

const ORG = "maple";
const dana: Principal = { kind: "user", subject: "dana" };
const kim: Principal = { kind: "user", subject: "kim" };

const memberships: Record<string, Membership[]> = {
  dana: [{ org: ORG, display: "Maple Bank", teams: ["support"], admin: true }],
  kim: [{ org: ORG, display: "Maple Bank", teams: ["support"] }],
};

const seeded = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

const ORIGIN = "https://maple.test";
const MCP = `${ORIGIN}/api/vendo/mcp`;
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-test-suite-1234567890";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** Whose SESSION this is (the wire half); the MCP half authenticates through
 *  the door's own OAuth and is always Kim below. */
let acting: Principal = dana;

async function boot(): Promise<{ vendo: Vendo; store: VendoStore }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-mcp-orgs-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });
  vi.stubEnv("VENDO_API_KEY", "vnd_mcp_orgs_key");
  const vendo = createVendo({
    store,
    auth: {
      principal: async () => acting,
      memberships: async (principal) => memberships[principal.subject] ?? [],
      oauth: {
        // The door owns every protocol mechanic; the host answers exactly two
        // questions, and this is the shape 10-mcp §3 asks for.
        async authorize() { return { subject: kim.subject }; },
        async principal(subject) { return { kind: "user", subject }; },
      },
    },
    mcp: true,
  });
  await store.ensureSchema();
  return { vendo, store };
}

async function call(
  vendo: Vendo,
  who: Principal,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  acting = who;
  const response = await vendo.handler(new Request(`${ORIGIN}/api/vendo${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

const pkceChallenge = async (verifier: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return Buffer.from(digest).toString("base64url");
};

/** An MCP client, spelled out in raw JSON-RPC over the composed handler: the
 *  whole client-side OAuth dance, then the streamable-HTTP session. (The SDK
 *  client is @vendoai/mcp's own test dependency; this package speaks the wire
 *  instead of taking one on.) */
async function connectOverMcp(vendo: Vendo): Promise<(name: string, args: Record<string, unknown>) => Promise<any>> {
  const registered = await (await vendo.handler(new Request(`${MCP}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test client", redirect_uris: [REDIRECT], scope: "read write" }),
  }))).json() as { client_id: string };

  const authorized = await vendo.handler(new Request(`${MCP}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: REDIRECT,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    scope: "read write",
    resource: MCP,
  })}`));
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;

  const tokens = await (await vendo.handler(new Request(`${MCP}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registered.client_id,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      resource: MCP,
    }),
  }))).json() as { access_token: string };

  let sessionId: string | undefined;
  let nextId = 1;
  const rpc = async (body: Record<string, unknown>): Promise<any> => {
    const response = await vendo.handler(new Request(MCP, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    }));
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    return text === "" ? undefined : JSON.parse(text);
  };

  await rpc({
    id: nextId++,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-orgs-test", version: "0" } },
  });
  await rpc({ method: "notifications/initialized" });

  return async (name, args) => (await rpc({
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  })).result;
}

const structured = (result: unknown): any =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

describe("F4 — a team app is reachable over MCP, not only over the wire", () => {
  it("lists and opens an org app the caller reaches through a TEAM grant", async () => {
    const { vendo, store } = await boot();
    await store.records("vendo_apps").put({
      id: "app_team",
      data: { subject: ORG, enabled: false, doc: seeded("app_team", "Team dashboard") },
      refs: { subject: ORG },
    });
    // Dana (org admin ⇒ implicit owner of every org app) shares it with the
    // support TEAM — the encoding that only an asserted membership can match.
    expect((await call(vendo, dana, "POST", "/apps/app_team/grants", {
      principal: `team:${ORG}/support`,
      level: "viewer",
    })).status).toBe(200);

    // The wire already answers correctly for Kim; that is the control.
    expect((await call(vendo, kim, "GET", "/apps")).body.map((app: AppDocument) => app.id))
      .toEqual(["app_team"]);

    const callTool = await connectOverMcp(vendo);
    const listed = structured(await callTool("vendo_apps_list", {}));
    expect(listed.map((app: AppDocument) => app.id)).toEqual(["app_team"]);

    const opened = await callTool("vendo_apps_open", { appId: "app_team" });
    expect(opened.isError ?? false).toBe(false);
  });

  it("still masks an app the caller's orgs do not reach", async () => {
    const { vendo, store } = await boot();
    await store.records("vendo_apps").put({
      id: "app_private",
      data: { subject: "dana", enabled: false, doc: seeded("app_private", "Dana's own") },
      refs: { subject: "dana" },
    });

    const callTool = await connectOverMcp(vendo);
    expect(structured(await callTool("vendo_apps_list", {}))).toEqual([]);
    const opened = await callTool("vendo_apps_open", { appId: "app_private" });
    expect(opened.isError).toBe(true);
  });
});
