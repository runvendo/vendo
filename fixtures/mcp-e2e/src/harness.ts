import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import type { AppDocument, Principal, ToolRegistry } from "@vendoai/core";
import { createActions } from "@vendoai/actions";
import { createApps, type AppsRuntime } from "@vendoai/apps";
import { createGuard, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createMcpDoor, type AppsPort, type HostOAuthAdapter } from "@vendoai/mcp";
import { createStore, type VendoStore } from "@vendoai/store";

export const SUBJECT = "user_1";
export const FIXTURE_APP_ID = "app_mcp_fixture";
export const MCP_MOUNT = "/api/vendo/mcp";

export const fixtureBaseUrl = (): string => inject("fixtureBaseUrl");

export const hostTools = [
  {
    name: "host_invoices_list",
    description: "List invoices",
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  },
  {
    name: "host_invoices_create",
    description: "Create invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "POST", path: "/api/invoices", argsIn: "body" },
  },
  {
    name: "host_invoices_get",
    description: "Get invoice",
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices/{id}", argsIn: "query" },
  },
  {
    name: "host_invoices_update",
    description: "Update invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "PATCH", path: "/api/invoices/{id}", argsIn: "body" },
  },
  {
    name: "host_invoices_send",
    description: "Send invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "POST", path: "/api/invoices/{id}/send", argsIn: "body" },
  },
  {
    name: "host_invoices_send_critical",
    description: "Send invoice with critical confirmation",
    inputSchema: { type: "object" },
    risk: "write",
    critical: true,
    binding: { kind: "route", method: "POST", path: "/api/invoices/{id}/send", argsIn: "body" },
  },
  {
    name: "host_invoices_delete",
    description: "Delete invoice",
    inputSchema: { type: "object" },
    risk: "destructive",
    binding: { kind: "route", method: "DELETE", path: "/api/invoices/{id}", argsIn: "query" },
  },
] as const;

const fixtureApp: AppDocument = {
  format: "vendo/app@1",
  id: FIXTURE_APP_ID,
  name: "MCP invoice fixture",
  description: "A rung-1 app served through the MCP Apps ride-along.",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { children: "Invoice fixture" } }],
    data: { fixture: true },
  },
};

export type OAuthMode = "auto" | "interactive";

export interface Stack {
  store: VendoStore;
  guard: VendoGuard;
  bound: ToolRegistry;
  apps: AppsRuntime;
  revoked: Set<string>;
  autoSubject?: string;
  oauthMode: OAuthMode;
  origin: string;
  endpoint: string;
  close(): Promise<void>;
  sql<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>;
}

export interface StackOptions {
  policy?: PolicyConfig;
  oauthMode?: OAuthMode;
  doorPort?: number;
}

export async function loginCookie(subject: string): Promise<string> {
  const response = await fetch(`${fixtureBaseUrl()}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: subject }),
  });
  if (!response.ok) throw new Error(`Fixture login failed (${response.status})`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Fixture login did not return a cookie");
  return cookie;
}

export async function resetFixture(): Promise<void> {
  const response = await fetch(`${fixtureBaseUrl()}/fixture/reset`, { method: "POST" });
  if (!response.ok) throw new Error(`Fixture reset failed (${response.status})`);
}

export async function createStack(options: StackOptions = {}): Promise<Stack> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-mcp-e2e-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const guard = createGuard({
    store,
    policy: options.policy ?? {
      rules: [
        { match: { risk: "destructive" }, action: "ask" },
        { match: { risk: "read" }, action: "run" },
        { match: { risk: "write" }, action: "run" },
      ],
    },
  });
  const control: { autoSubject?: string; oauthMode: OAuthMode } = {
    autoSubject: SUBJECT,
    oauthMode: options.oauthMode ?? "auto",
  };
  const revoked = new Set<string>();
  const fixtureFetch: typeof fetch = async (input, init) => {
    const subject = control.autoSubject ?? SUBJECT;
    const headers = new Headers(init?.headers);
    headers.set("cookie", await loginCookie(subject));
    return fetch(input, { ...init, headers });
  };
  const actions = createActions({
    tools: hostTools as unknown as Parameters<typeof createActions>[0]["tools"],
    baseUrl: fixtureBaseUrl(),
    fetch: fixtureFetch,
  });
  const bound = guard.bind(actions);
  const apps = createApps({ store, guard, tools: bound, catalog: [] });
  await store.records("vendo_apps").put({
    id: fixtureApp.id,
    data: { subject: SUBJECT, enabled: false, doc: fixtureApp },
    refs: { subject: SUBJECT },
  });
  const oauth: HostOAuthAdapter = {
    async authorize() {
      if (control.oauthMode === "interactive") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://fixture.example/consent" },
        });
      }
      if (!control.autoSubject) return new Response("missing fixture session", { status: 401 });
      return { subject: control.autoSubject };
    },
    async principal(subject) {
      return revoked.has(subject)
        ? null
        : { kind: "user", subject, display: `Fixture ${subject}` } satisfies Principal;
    },
  };
  const appsPort: AppsPort = {
    list: (ctx) => apps.list(ctx),
    async open(appId, ctx) {
      const opened = await apps.open(appId, ctx);
      if (opened.kind === "resuming") throw new Error("rung-1 fixture cannot resume");
      return opened.kind === "tree"
        ? { kind: "tree", payload: opened.payload }
        : opened;
    },
    call: (appId, ref, args, ctx) => apps.call(appId, ref, args, ctx),
  };
  const door = createMcpDoor({ tools: bound, guard, oauth, store, apps: appsPort });
  const httpServer = createServer((req, res) => {
    void forwardToDoor(req, res, door.handler);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.doorPort ?? 0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Door server did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;

  const stack: Stack = {
    store,
    guard,
    bound,
    apps,
    revoked,
    get autoSubject() { return control.autoSubject; },
    set autoSubject(value) { control.autoSubject = value; },
    get oauthMode() { return control.oauthMode; },
    set oauthMode(value) { control.oauthMode = value; },
    origin,
    endpoint: `${origin}${MCP_MOUNT}`,
    async sql(query, params) {
      const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };
      return (await raw.query(query, params)).rows as never;
    },
    async close() {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  return stack;
}

async function forwardToDoor(
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
    res.end(error instanceof Error ? error.message : "door bridge failed");
  }
}
