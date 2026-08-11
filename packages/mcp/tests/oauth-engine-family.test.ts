// The door's own two drawers — the registered clients, and the whole grant
// family (consent interactions, authorization codes, access and refresh grants,
// family anchors) — are Vendo's OWN data. They reach the store through the named
// `engine` family and its allowlist, not through the generic `records` façade a
// HOST uses for its own rows.
//
// Both counterparties here are real. Writes go out through the door's own OAuth
// endpoints — register, authorize, the consent post, /token, a refresh rotation,
// the service-key exchange, revoke, revokeClient — and every row is read back
// through the very same surface the door wrote it to, gate included: the real
// in-core StoreOps reference (`memoryStoreOps`) for the composed path, the real
// adapter's own record door for the fallback. Neither side is stubbed, so the
// producer and the consumer cannot be made to agree by construction.
import {
  isEngineCollection,
  type Guard,
  type StoreAdapter,
  type StoreOps,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter, memoryStoreOps } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { createMcpDoor, type HostOAuthAdapter, type McpDoor } from "../src/index.js";

const BASE = "https://product.example/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "v".repeat(64);
const SERVICE_KEY = "svc-key-for-the-engine-family-test";
const SUBJECT = "user_1";

interface Op {
  verb: string;
  collection: string;
}

/** The real memory StoreOps with a note taken of every collection-addressed
 *  call. A spy, not a stub: each verb delegates, so the reads below come back
 *  through the same surface the writes went out on. */
function recordingOps(): { ops: StoreOps; traffic: Op[] } {
  const real = memoryStoreOps();
  const traffic: Op[] = [];
  const note = (verb: string, collection: string): void => {
    traffic.push({ verb, collection });
  };
  const engine: StoreOps["engine"] = {
    get: (c, id) => (note("get", c), real.engine.get(c, id)),
    put: (c, record) => (note("put", c), real.engine.put(c, record)),
    delete: (c, id) => (note("delete", c), real.engine.delete(c, id)),
    list: (c, query) => (note("list", c), real.engine.list(c, query)),
    claim: (c, expected, replacement) => (note("claim", c), real.engine.claim(c, expected, replacement)),
    insertIfAbsent: (c, record) => (note("insertIfAbsent", c), real.engine.insertIfAbsent(c, record)),
    compareAndSwap: (c, record, revision) =>
      (note("compareAndSwap", c), real.engine.compareAndSwap(c, record, revision)),
  };
  return { ops: { ...real, engine }, traffic };
}

/** The adapter with its generic records façade sealed shut. With `ops` set no
 *  drawer may be reached through it, so a lingering `records()` call fails loudly
 *  instead of quietly opening a second path to the same rows. */
function sealedFacade(base: StoreAdapter): StoreAdapter {
  return {
    ...base,
    records() {
      throw new Error("the door reached a drawer through the generic records façade");
    },
  };
}

/** The prebuilt-consent door: a host session and nothing else, so the authorize
 *  leg mints a consent interaction the POST then claims. */
function makeDoor(wiring: { store: StoreAdapter; ops?: StoreOps }): McpDoor {
  const guard: Guard = {
    async check() { return { action: "run", decidedBy: "default" }; },
    async report() { return undefined; },
    async directions() { return []; },
    onApprovalDecision() { return () => undefined; },
  };
  const tools: ToolRegistry = {
    async descriptors() { return []; },
    async execute() { return { status: "ok", output: {} }; },
  };
  const oauth: HostOAuthAdapter = {
    async session() { return { subject: SUBJECT }; },
    async principal(subject) { return { kind: "user", subject }; },
  };
  return createMcpDoor({
    tools,
    guard,
    oauth,
    serviceAuth: { keys: [SERVICE_KEY] },
    ...wiring,
  });
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return Buffer.from(digest).toString("base64url");
}

/** What the service-key exchange calls the acting client: the presented key's
 *  digest, truncated, so a row names which key acted without holding the key. */
async function serviceClientId(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return `svc:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 8)}`;
}

function inputValue(html: string, name: string): string {
  const match = html.match(new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]+)"`, "i"));
  if (!match?.[1]) throw new Error(`Consent page omitted ${name}`);
  return match[1];
}

function formAction(html: string): string {
  const match = html.match(/<form[^>]+action="([^"]+)"/i);
  if (!match?.[1]) throw new Error("Consent page omitted the form action");
  return match[1].replaceAll("&amp;", "&");
}

async function form(door: McpDoor, path: string, fields: Record<string, string>): Promise<Response> {
  return door.handler(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  }));
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

/** One pass over every drawer the door owns, entirely through its own wire:
 *  register a client, authorize behind the prebuilt consent page, approve it,
 *  redeem the code, use the access token, rotate the refresh token, exchange a
 *  service key, then revoke an access token, a refresh token and the client. */
async function exerciseEveryDrawer(door: McpDoor): Promise<{ clientId: string }> {
  const registered = await door.handler(new Request(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Engine family client", redirect_uris: [REDIRECT], scope: "read write" }),
  }));
  expect(registered.status).toBe(201);
  const { client_id: clientId } = await registered.json() as { client_id: string };

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    scope: "read write",
    resource: BASE,
  });
  const consentPage = await door.handler(new Request(`${BASE}/authorize?${params}`));
  expect(consentPage.status).toBe(200);
  const html = await consentPage.text();

  const approved = await door.handler(new Request(formAction(html), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction: inputValue(html, "transaction"),
      csrf_token: inputValue(html, "csrf_token"),
      decision: "approve",
    }),
  }));
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

  const redeemed = await form(door, "/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  expect(redeemed.status).toBe(200);
  const first = await redeemed.json() as Tokens;

  // The access token is spent on a real MCP request, so `authenticate` reads the
  // grant back out of the drawer it was just written to. Anything but a 401 is
  // proof it was found — what the MCP layer then answers is not this test's.
  const used = await door.handler(new Request(BASE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine-family", version: "1" } },
    }),
  }));
  expect(used.status).not.toBe(401);

  const rotated = await form(door, "/token", {
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    client_id: clientId,
  });
  expect(rotated.status).toBe(200);
  const second = await rotated.json() as Tokens;

  // The service-key exchange: one familyless access grant, which is the only
  // row a family sweep cannot reach.
  const exchanged = await form(door, "/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: "vendo-service",
    client_secret: SERVICE_KEY,
    subject_token: SUBJECT,
    subject_token_type: "urn:vendo:params:oauth:token-type:user-id",
    resource: BASE,
  });
  expect(exchanged.status).toBe(200);

  // Four revocation shapes: a token record (the access grant), a family anchor
  // (the refresh grant), the host-side per-client disconnect, and that same
  // disconnect for the SERVICE client — whose grant has no family anchor, so it
  // is the one row a family sweep cannot reach.
  expect((await form(door, "/revoke", { token: second.access_token, client_id: clientId })).status).toBe(200);
  expect((await form(door, "/revoke", { token: second.refresh_token, client_id: clientId })).status).toBe(200);
  await door.revokeClient(SUBJECT, clientId);
  await door.revokeClient(SUBJECT, await serviceClientId(SERVICE_KEY));

  return { clientId };
}

describe("the door's own drawers ride the engine family", () => {
  it("names only allowlisted collections, and never the records façade", async () => {
    const { ops, traffic } = recordingOps();
    const door = makeDoor({ store: sealedFacade(memoryStoreAdapter()), ops });

    await exerciseEveryDrawer(door);

    const collections = [...new Set(traffic.map((op) => op.collection))].sort();
    expect(collections.filter((c) => !isEngineCollection(c))).toEqual([]);
    expect(collections).toEqual(["vendo_mcp_clients", "vendo_mcp_grants"]);
  });

  it("reads every row back through the same surface it wrote them to", async () => {
    const { ops, traffic } = recordingOps();
    const door = makeDoor({ store: sealedFacade(memoryStoreAdapter()), ops });

    const { clientId } = await exerciseEveryDrawer(door);

    // The registered client, in the dedicated clients drawer.
    const client = await ops.engine.get("vendo_mcp_clients", clientId);
    expect((client?.data as { client_name?: string }).client_name).toBe("Engine family client");

    // Single-use state is claimed, never put over: the consent interaction and
    // the authorization code are both spent through `claim`.
    expect(traffic.filter((op) => op.collection === "vendo_mcp_grants" && op.verb === "claim").length)
      .toBeGreaterThan(0);

    // The consent interaction is gone — claimed with no replacement erases it.
    const consents = await ops.engine.list("vendo_mcp_grants", { refs: { kind: "consent" } });
    expect(consents.records).toEqual([]);

    // Every family anchor this subject/client pair ever had is revoked, and the
    // familyless service grant the sweep cannot reach is revoked on its own.
    const families = await ops.engine.list("vendo_mcp_grants", {
      refs: { kind: "family", subject: SUBJECT, client_id: clientId },
    });
    expect(families.records).toHaveLength(1);
    expect((families.records[0]!.data as { status?: string }).status).toBe("revoked");
    const service = await ops.engine.list("vendo_mcp_grants", {
      refs: { kind: "access", subject: SUBJECT, client_id: await serviceClientId(SERVICE_KEY) },
    });
    expect(service.records).toHaveLength(1);
    expect((service.records[0]!.data as { revokedAt?: string }).revokedAt).toBeDefined();
  });
});

describe("without an ops surface the same verbs run on the adapter", () => {
  it("lands every row through the adapter's own record door", async () => {
    // An unset `ops` is a route, not a downgrade: same collections, same verbs,
    // same rows — `engineOverAdapter` puts the allowlist gate in front of the
    // adapter the host brought, and the whole OAuth flow still completes.
    const store = memoryStoreAdapter();
    const door = makeDoor({ store });

    const { clientId } = await exerciseEveryDrawer(door);

    // Read back through the façade this time, because that IS the fallback's
    // write path — the same rows, reached the way a BYO adapter reaches them.
    expect((await store.records("vendo_mcp_clients").get(clientId))?.data)
      .toMatchObject({ client_name: "Engine family client" });
    const grants = await store.records("vendo_mcp_grants").list({});
    expect(grants.records.length).toBeGreaterThan(0);
    const families = grants.records.filter((record) => (record.data as { kind?: string }).kind === "family");
    expect(families).toHaveLength(1);
    expect((families[0]!.data as { status?: string }).status).toBe("revoked");
  });

  it("refuses a collection outside the engine allowlist", async () => {
    // The gate rides the fallback too, so a BYO adapter is not a way around it.
    const store = memoryStoreAdapter();
    const door = makeDoor({ store });
    await exerciseEveryDrawer(door);

    // Nothing the door writes lands anywhere but its own two drawers.
    expect(isEngineCollection("vendo_mcp_clients")).toBe(true);
    expect(isEngineCollection("vendo_mcp_grants")).toBe(true);
    expect((await store.records("vendo_records").list({})).records).toEqual([]);
  });
});
