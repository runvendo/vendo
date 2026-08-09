/**
 * The theme seam: `@vendoai/ui` and `@vendoai/mcp` render the SAME theme
 * through three different transports — a React style object, a `style`
 * attribute on the door's connect page, and a `:root{}` block inside the MCP
 * Apps shim. Each used to carry its own hand-kept copy of the mapping, and they
 * had drifted (the door emitted 16 of the chrome's 32 variables) with every
 * suite green, because no test ever put two of them side by side.
 *
 * The umbrella is the only package allowed to import both blocks, so this is
 * the only place the comparison can be made. Nothing here is stubbed: the MCP
 * side goes through the real door over real Requests, including the OAuth
 * handshake the shim resource sits behind.
 */
import {
  VENDO_THEME_VARIABLE_NAMES,
  canonicalJson,
  type BlobStore,
  type Guard,
  type RecordQuery,
  type RecordStore,
  type StoreAdapter,
  type ToolRegistry,
  type VendoRecord,
  type VendoTheme,
} from "@vendoai/core";
import { createMcpDoor, type McpDoor } from "@vendoai/mcp";
import { themeCssVariables } from "@vendoai/ui";
import { describe, expect, it } from "vitest";

const BASE = "https://product.example/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-theme-seam-1234567890";

const THEME: VendoTheme = {
  colors: {
    background: "#0d0f14",
    surface: "#171a21",
    text: "#f2f2f5",
    muted: "#9a9ba6",
    accent: "#0A7CFF",
    accentText: "#ffffff",
    danger: "#B42318",
    border: "#2b2e37",
  },
  typography: { fontFamily: "Maple Sans, system-ui, sans-serif", headingFamily: "Newsreader, serif", baseSize: "16px" },
  radius: { small: "4px", medium: "14px", large: "22px" },
  density: "compact",
  motion: "reduced",
};

describe("theme seam — ui and mcp serialize one mapping", () => {
  it("the chrome, the door's pages and the MCP Apps shim emit the same variable set", async () => {
    const door = makeDoor(THEME);

    const chrome = new Set(Object.keys(themeCssVariables(THEME)));
    const connect = variableNames(styleAttribute(await text(door.handler(new Request(`${BASE}/connect`)))));
    const shim = variableNames(rootBlock(await readShim(door)));

    expect(connect).toEqual(chrome);
    expect(shim).toEqual(chrome);
    // …and that set IS the list core publishes for consumers to teach and read.
    expect(chrome).toEqual(new Set(VENDO_THEME_VARIABLE_NAMES));
    // Not a set of one: the mapping's whole output, including the axes the door
    // used to drop on the floor.
    for (const name of ["--vendo-color-scheme", "--vendo-base-size", "--vendo-density-card-padding", "--vendo-motion-duration"]) {
      expect(connect.has(name)).toBe(true);
      expect(shim.has(name)).toBe(true);
    }
  }, 30_000);

  it("an unthemed door renders no variables at all, where the chrome merges defaults", async () => {
    const door = makeDoor(undefined);

    // ui: no host theme still resolves to the neutral default, so the chrome
    // always has a full set to paint with — every variable but the optional
    // headingFamily, which a host either declares or does not.
    expect(new Set(Object.keys(themeCssVariables(defaultsProbe()))))
      .toEqual(new Set(VENDO_THEME_VARIABLE_NAMES.filter((name) => name !== "--vendo-heading-family")));

    // mcp: both paths render NOTHING rather than imposing Vendo's default on a
    // host that declared no brand.
    const connect = await text(door.handler(new Request(`${BASE}/connect`)));
    expect(connect).not.toContain("<html lang=\"en\" style=");
    expect(connect).not.toContain("--vendo-color-accent:");
    const shim = await readShim(door);
    expect(shim).not.toContain("data-vendo-mcp-theme");
    expect(shim).not.toContain("--vendo-color-accent:");
  }, 30_000);
});

/** The default theme has no headingFamily, so the mapping emits 31 of its 32. */
function defaultsProbe(): VendoTheme {
  return { ...THEME, typography: { fontFamily: "system-ui", baseSize: "15px" } };
}

// --- parsing the two serializations -----------------------------------------

const text = async (response: Promise<Response>): Promise<string> => (await response).text();

/** The `style` attribute the door puts on `<html>` (page-chrome's serialization). */
function styleAttribute(html: string): string {
  const match = /<html[^>]+style="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error("the connect page carried no theme style attribute");
  return match[1].replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

/** The `:root{}` declarations inside the shim's theme style element (door.ts's). */
function rootBlock(html: string): string {
  const match = /<style data-vendo-mcp-theme>:root\{([^}]+)\}<\/style>/.exec(html);
  if (match?.[1] === undefined) throw new Error("the MCP Apps shim carried no theme style element");
  return match[1];
}

function variableNames(serialized: string): Set<string> {
  return new Set(
    serialized.split(";")
      .filter((declaration) => declaration.trim() !== "")
      .map((declaration) => declaration.slice(0, declaration.indexOf(":")).trim()),
  );
}

// --- the real door ----------------------------------------------------------

function makeDoor(theme: VendoTheme | undefined): McpDoor {
  const tools: ToolRegistry = {
    async descriptors() {
      return [{ name: "host_lookup", description: "Look something up", inputSchema: { type: "object" }, risk: "read" }];
    },
    async execute() { return { status: "ok", output: {} }; },
  };
  const guard: Guard = {
    async check() { return { action: "run", decidedBy: "default" }; },
    async report() { return undefined; },
    async directions() { return []; },
    onApprovalDecision() { return () => undefined; },
  };
  return createMcpDoor({
    tools,
    guard,
    store: new MemoryStore(),
    // The shim resource is only served by a door that carries apps.
    apps: { async list() { return []; }, async open() { return { kind: "http", url: "https://x.example" }; }, async call() { return null; } },
    ...(theme === undefined ? {} : { theme }),
    mount: "/api/vendo/mcp",
    baseUrl: "https://product.example",
    oauth: {
      async authorize() { return { subject: "user_1" }; },
      async principal(subject) { return { kind: "user", subject }; },
    },
  });
}

/** The shim HTML as a real MCP client sees it: register, authorize, exchange,
 * initialize, then `resources/read` — no shortcut around the door. */
async function readShim(door: McpDoor): Promise<string> {
  const registered = await rpcJson(door.handler(new Request(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "theme-seam", redirect_uris: [REDIRECT], scope: "read write" }),
  }))) as { client_id: string };

  const params = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: REDIRECT,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    scope: "read write",
    resource: BASE,
  });
  const authorized = await door.handler(new Request(`${BASE}/authorize?${params}`));
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;

  const tokens = await rpcJson(door.handler(new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code,
      client_id: registered.client_id,
      code_verifier: VERIFIER,
      resource: BASE,
    }),
  }))) as { access_token: string };

  const token = tokens.access_token;
  const initialized = await door.handler(mcp(token, undefined, {
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "theme-seam", version: "0" } },
  }));
  const sessionId = initialized.headers.get("mcp-session-id")!;
  await frames(initialized);
  await door.handler(mcp(token, sessionId, { method: "notifications/initialized" }));

  const read = await frames(await door.handler(mcp(token, sessionId, {
    id: 2,
    method: "resources/read",
    params: { uri: "ui://vendo/tree-shim.html" },
  })));
  const contents = (read as { result: { contents: Array<{ text?: string }> } }).result.contents;
  const html = contents[0]?.text;
  if (html === undefined) throw new Error("the door served the shim resource without text");
  return html;
}

function mcp(token: string, sessionId: string | undefined, body: Record<string, unknown>): Request {
  return new Request(BASE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}

async function rpcJson(response: Promise<Response>): Promise<unknown> {
  const settled = await response;
  expect(settled.status).toBeLessThan(400);
  return settled.json();
}

/** The transport answers a POST as JSON or as a one-frame SSE stream; both carry
 * the same JSON-RPC envelope. */
async function frames(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body.startsWith("event:") && !body.startsWith("data:")) return body === "" ? undefined : JSON.parse(body);
  const data = body.split("\n").find((line) => line.startsWith("data:"));
  return data === undefined ? undefined : JSON.parse(data.slice("data:".length).trim());
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return Buffer.from(digest).toString("base64url");
}

/** The door's protocol state (clients, codes, grants) — in memory for the test. */
class MemoryStore implements StoreAdapter {
  readonly #collections = new Map<string, Map<string, VendoRecord>>();

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
        if (replacement === undefined) rows.delete(expected.id);
        else {
          rows.set(expected.id, {
            id: expected.id,
            data: structuredClone(replacement.data),
            ...(replacement.refs === undefined ? {} : { refs: { ...replacement.refs } }),
            createdAt: current.createdAt,
            updatedAt: new Date().toISOString(),
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

  async ensureSchema(): Promise<void> { return undefined; }
}
