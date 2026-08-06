import {
  canonicalJson,
  type AuditEvent,
  type BlobStore,
  type Guard,
  type RecordQuery,
  type RecordStore,
  type StoreAdapter,
  type ToolRegistry,
  type VendoRecord,
} from "@vendoai/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createMcpDoor, type McpDoor } from "./index.js";
import { vendoUserToken } from "./user-token.js";

const BASE = "https://product.example/api/vendo/mcp";
const BROKER = "https://tenant.mcp.vendo.run";
/** The same broker, mounted under a PATH — the shape an own-AS deployment uses
 *  (`packages/vendo/src/server.test.ts` issues from `…/api/vendo/mcp`). */
const PATH_BROKER = "https://broker.example/api/vendo/mcp";
const SERVICE_KEY = "vsk_0a1b2c3d_0123456789abcdef0123456789abcdef01234567";
const SERVICE_KEY_B = "vsk_5f6e7d8c_fedcba9876543210fedcba9876543210fedcba98";

describe("vendoUserToken", () => {
  it("exchanges a key and a user id for a token that works on a real tools/call", async () => {
    const door = makeDoor({ serviceAuth: { keys: [SERVICE_KEY] } });
    const seen: string[] = [];

    const token = await vendoUserToken({
      url: BASE,
      key: SERVICE_KEY,
      user: "user_1",
      fetch: doorFetch({ "https://product.example": door }, seen),
    });

    expect(token.accessToken).toMatch(/^vmat_[A-Za-z0-9_-]{43}$/);
    expect(token.tokenType).toBe("Bearer");
    expect(token.expiresIn).toBe(600);
    expect(token.scope).toBe("read write");
    expect(token.expiresAt.getTime() - Date.now()).toBeGreaterThan(500_000);
    expect(token.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    // The door's own discovery document is what named the token endpoint.
    expect(seen).toEqual([
      "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
      `${BASE}/token`,
    ]);

    const client = await connect(door, token.accessToken);
    const result = await client.callTool({ name: "host_lookup", arguments: { query: "balance" } });
    expect(JSON.stringify(result)).toContain("42");
    await client.close();
  });

  it("follows a door that trusts an external authorization server to that server's token endpoint", async () => {
    // The broker case: the deployment's own door serves no token endpoint, and
    // its RFC 9728 document names the broker — which publishes where to go.
    const deployment = makeDoor({ remoteAs: { issuer: BROKER, audience: BASE } });
    const broker = makeDoor({ serviceAuth: { keys: [SERVICE_KEY] } });
    const seen: string[] = [];

    const token = await vendoUserToken({
      url: BASE,
      key: SERVICE_KEY,
      user: "user_1",
      fetch: doorFetch({ "https://product.example": deployment, [BROKER]: broker }, seen),
    });

    expect(token.accessToken).toMatch(/^vmat_/);
    expect(seen).toEqual([
      "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
      `${BROKER}/.well-known/oauth-authorization-server`,
      `${BROKER}/token`,
    ]);
  });

  it("finds a PATH-MOUNTED authorization server's metadata where RFC 8414 puts it", async () => {
    // RFC 8414 §3: for an issuer that carries a path, the well-known segment is
    // INSERTED between the origin and the path — it is not suffixed. A Vendo
    // door serves its own AS metadata at that insertion spelling and at no
    // other, so suffixing names an MCP path rather than a document. Both doors
    // here are real; nothing is hand-written.
    const deployment = makeDoor({ remoteAs: { issuer: PATH_BROKER, audience: BASE } });
    const broker = makeDoor({ serviceAuth: { keys: [SERVICE_KEY] } });
    const seen: string[] = [];

    const token = await vendoUserToken({
      url: BASE,
      key: SERVICE_KEY,
      user: "user_1",
      fetch: doorFetch({ "https://product.example": deployment, "https://broker.example": broker }, seen),
    });

    expect(token.accessToken).toMatch(/^vmat_/);
    expect(seen).toEqual([
      "https://product.example/.well-known/oauth-protected-resource/api/vendo/mcp",
      "https://broker.example/.well-known/oauth-authorization-server/api/vendo/mcp",
      `${PATH_BROKER}/token`,
    ]);
  });

  it("names the resource the token is for, so nothing else decides the audience", async () => {
    const door = makeDoor({ serviceAuth: { keys: [SERVICE_KEY] } });
    const answer = doorFetch({ "https://product.example": door });
    const posted: URLSearchParams[] = [];
    const record: typeof fetch = async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (request.method === "POST") posted.push(new URLSearchParams(await request.clone().text()));
      return answer(request);
    };

    await vendoUserToken({ url: BASE, key: SERVICE_KEY, user: "user_1", fetch: record });

    // RFC 8693 §2.1 `resource` is the audience the caller is asking for, and the
    // door validates it (`invalid_target`). Leaving it off makes the token
    // endpoint's own mount decide — which on the broker path is the BROKER, not
    // the deployment the backend actually wants to talk to.
    expect(posted).toHaveLength(1);
    expect(posted[0]!.get("resource")).toBe(BASE);
  });

  it("surfaces the door's OAuth error", async () => {
    const door = makeDoor({ serviceAuth: { keys: [SERVICE_KEY] } });
    await expect(vendoUserToken({
      url: BASE,
      key: SERVICE_KEY_B,
      user: "user_1",
      fetch: doorFetch({ "https://product.example": door }),
    })).rejects.toThrow(/invalid_client: Service key is not valid for this MCP server/);
  });

  it("gives up at timeoutMs", async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(init.signal!.reason as Error); });
    });
    await expect(vendoUserToken({
      url: BASE,
      key: SERVICE_KEY,
      user: "user_1",
      fetch: hang,
      timeoutMs: 20,
    })).rejects.toThrow(/aborted due to timeout/i);
  });
});

/** Every request the helper makes, answered by a REAL composed door — the
 *  broker's authorization-server document is the only hand-written JSON, and
 *  it is a metadata document, not an endpoint. */
function doorFetch(doors: Record<string, McpDoor>, seen: string[] = []): typeof fetch {
  return async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    seen.push(request.url);
    if (request.url === `${BROKER}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: BROKER,
        authorization_endpoint: `${BROKER}/authorize`,
        token_endpoint: `${BROKER}/token`,
        grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:token-exchange"],
      });
    }
    const door = doors[url.origin];
    if (door === undefined) throw new Error(`No door at ${url.origin}`);
    return door.handler(request);
  };
}

async function connect(door: McpDoor, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      return door.handler(new Request(input, { ...init, headers }));
    },
  });
  const client = new Client({ name: "user-token-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function makeDoor(options: {
  serviceAuth?: { keys: readonly string[] };
  remoteAs?: { issuer: string; audience: string };
}): McpDoor {
  const guard: Guard = {
    async check() { return { action: "run", decidedBy: "default" }; },
    async report(_event: AuditEvent) { return undefined; },
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
      }];
    },
    async execute() { return { status: "ok", output: { answer: 42 } }; },
  };
  return createMcpDoor({
    tools,
    guard,
    store: new MemoryStore(),
    ...(options.serviceAuth === undefined ? {} : { serviceAuth: options.serviceAuth }),
    ...(options.remoteAs === undefined ? {} : { remoteAs: options.remoteAs }),
    oauth: {
      async authorize() { return { subject: "user_1" }; },
      async principal(subject) { return { kind: "user", subject }; },
    },
  });
}

class MemoryStore implements StoreAdapter {
  readonly #collections = new Map<string, Map<string, VendoRecord>>();

  records(collection: string): RecordStore {
    const rows = this.#collections.get(collection) ?? new Map<string, VendoRecord>();
    this.#collections.set(collection, rows);
    return {
      async get(id) { return rows.get(id) ?? null; },
      async put(record) {
        const now = new Date().toISOString();
        const stored: VendoRecord = {
          id: record.id,
          data: structuredClone(record.data),
          ...(record.refs === undefined ? {} : { refs: { ...record.refs } }),
          createdAt: rows.get(record.id)?.createdAt ?? now,
          updatedAt: now,
        };
        rows.set(stored.id, stored);
        return stored;
      },
      async claim(expected, replacement) {
        const current = rows.get(expected.id);
        if (!current || canonicalJson(current.data) !== canonicalJson(expected.data)) return false;
        if (replacement === undefined) rows.delete(expected.id);
        else rows.set(expected.id, { ...current, ...replacement, updatedAt: new Date().toISOString() });
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
