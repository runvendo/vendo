import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppDocument, AppId, ToolRegistry, UIPayload } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createMcpDoor, type AppsPort, type HostOAuthAdapter } from "@vendoai/mcp";
import { createStore } from "@vendoai/store";
import { JAIL_PROBE_HTML } from "./jail-probe-html.js";

export const PROBE_MOUNT = "/probe/mcp";
export const REAL_DOOR_MOUNT = "/api/vendo/mcp";
const PROBE_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${PROBE_MOUNT}`;
const PROBE_AUTHORIZATION_METADATA_PATH = `/.well-known/oauth-authorization-server${PROBE_MOUNT}`;
export const PROBE_RESOURCE_URI = "ui://vendo/jail-capability-probe.html";
export const REAL_JAIL_APP_ID = "app_jail_probe" as AppId;
export const PROBE_USERNAME = "probe";
export const PROBE_PASSWORD = "jail";
const PROBE_SUBJECT = "user_jail_probe";

const appUiMeta = (resourceUri: string) => ({
  ui: { resourceUri },
  "ui/resourceUri": resourceUri,
});

export const REAL_JAIL_PAYLOAD: UIPayload = {
  formatVersion: "vendo-genui/v1",
  root: "root",
  nodes: [{
    id: "root",
    component: "JailProbeCard",
    source: "generated",
    props: { title: "REAL VENDO JAIL: PASS" },
  }],
  components: {
    JailProbeCard: `import React from "react";
export default function JailProbeCard({ title }) {
  const [count, setCount] = React.useState(0);
  return <section style={{ padding: 24, border: "4px solid #159447", borderRadius: 14, fontFamily: "system-ui" }}>
    <h1 style={{ margin: 0, fontSize: 30 }}>{title}</h1>
    <p>Generated TSX compiled and rendered through JailedComponent's two nested srcdoc frames.</p>
    <button type="button" onClick={() => setCount((value) => value + 1)}>Exercise jailed React</button>
    <strong style={{ display: "block", marginTop: 12 }}>Jail interactions: {count}</strong>
  </section>;
}`,
  },
};

const REAL_JAIL_APP: AppDocument = {
  format: "vendo/app@1",
  id: REAL_JAIL_APP_ID,
  name: "ENG-277 real jail probe",
  description: "Generated component payload served through the real Vendo MCP door and shim.",
  tree: REAL_JAIL_PAYLOAD,
  components: REAL_JAIL_PAYLOAD.components as Record<string, string>,
};

export interface ProbeStackOptions {
  port?: number;
  host?: string;
  /** Test-only shortcut. The public fixture always uses interactive login + consent. */
  autoAuthorize?: boolean;
}

export interface ProbeStack {
  origin: string;
  probeEndpoint: string;
  realDoorEndpoint: string;
  close(): Promise<void>;
}

export async function createProbeStack(options: ProbeStackOptions = {}): Promise<ProbeStack> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-eng-277-probe-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();

  const guard = createGuard({
    store,
    policy: { rules: [{ match: { risk: "read" }, action: "run" }, { match: { risk: "write" }, action: "run" }] },
  });
  const tools: ToolRegistry = {
    async descriptors() { return []; },
    async execute() {
      return { status: "error", error: { code: "not-found", message: "fixture has no host tools" } };
    },
  };
  const oauth: HostOAuthAdapter = {
    async authorize(request, context) {
      if (options.autoAuthorize) return { subject: PROBE_SUBJECT };
      if (readCookie(request.headers.get("cookie"), "probe_session") !== PROBE_SUBJECT) {
        const login = new URL("/fixture/login", request.url);
        login.searchParams.set("return_to", request.url);
        return new Response(null, { status: 302, headers: { location: login.href } });
      }
      const url = new URL(request.url);
      if (url.searchParams.get("probe_consent") === "allow") return { subject: PROBE_SUBJECT };
      return html(consentPage(url, context.clientName, context.scopes));
    },
    async principal(subject) {
      return subject === PROBE_SUBJECT
        ? { kind: "user", subject, display: "ENG-277 Probe User" }
        : null;
    },
  };
  const apps: AppsPort = {
    async list() { return [REAL_JAIL_APP]; },
    async open(appId) {
      if (appId !== REAL_JAIL_APP_ID) throw new Error(`unknown probe app: ${appId}`);
      return { kind: "tree", payload: structuredClone(REAL_JAIL_PAYLOAD) };
    },
    async call() { return { ok: true }; },
  };
  const door = createMcpDoor({ tools, guard, oauth, store, apps, mount: REAL_DOOR_MOUNT });
  const probeHandler = createCapabilityProbeHandler();

  const server = createServer((request, response) => {
    void handleIncoming(request, response, probeHandler, door.handler);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3210, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("probe stack did not bind a TCP port");
  const origin = `http://${options.host ?? "127.0.0.1"}:${address.port}`;

  return {
    origin,
    probeEndpoint: `${origin}${PROBE_MOUNT}`,
    realDoorEndpoint: `${origin}${REAL_DOOR_MOUNT}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function createCapabilityProbeHandler(): (request: Request) => Promise<Response> {
  return async (request) => {
    const server = new McpServer(
      { name: "vendo-eng-277-jail-probe", version: "1.0.0" },
      { capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } } },
    );
    server.registerTool("vendo_jail_probe", {
      title: "Vendo jail capability probe",
      description: "Render eval, nested srcdoc, postMessage, and inherited-CSP results in a visible MCP App.",
      _meta: appUiMeta(PROBE_RESOURCE_URI),
    }, async () => ({
      content: [{ type: "text", text: "The ENG-277 jail capability probe is running in the attached MCP App." }],
      structuredContent: { probe: "eng-277", status: "running" },
      _meta: appUiMeta(PROBE_RESOURCE_URI),
    }));
    server.registerResource(
      "Vendo jail capability probe",
      PROBE_RESOURCE_URI,
      { mimeType: "text/html;profile=mcp-app" },
      async () => ({
        contents: [{ uri: PROBE_RESOURCE_URI, mimeType: "text/html;profile=mcp-app", text: JAIL_PROBE_HTML }],
      }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}

async function handleIncoming(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  probeHandler: (request: Request) => Promise<Response>,
  doorHandler: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const request = await toWebRequest(incoming);
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/healthz") {
      response = Response.json({ ok: true, probe: PROBE_MOUNT, realDoor: REAL_DOOR_MOUNT });
    } else if (url.pathname === "/fixture/login") {
      response = await loginRoute(request);
    } else if (url.pathname === PROBE_MOUNT) {
      response = await probeHandler(request);
    } else if (isProbeOAuthPath(url.pathname)) {
      // The standalone probe is intentionally no-auth. Without this namespace
      // fence the co-hosted real door answers probe-scoped discovery and auth
      // routes, causing clients to invent an OAuth flow for /probe/mcp.
      response = new Response("Not found", { status: 404 });
    } else {
      response = await doorHandler(request);
    }
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "text/plain; charset=utf-8");
    outgoing.end(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

function isProbeOAuthPath(pathname: string): boolean {
  return pathname === PROBE_RESOURCE_METADATA_PATH
    || pathname.startsWith(`${PROBE_RESOURCE_METADATA_PATH}/`)
    || pathname === PROBE_AUTHORIZATION_METADATA_PATH
    || pathname.startsWith(`${PROBE_AUTHORIZATION_METADATA_PATH}/`)
    || pathname.startsWith(`${PROBE_MOUNT}/`);
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const forwardedHost = firstHeader(headers.get("x-forwarded-host")) ?? headers.get("host") ?? "127.0.0.1";
  const forwardedProto = firstHeader(headers.get("x-forwarded-proto")) ?? "http";
  const configuredOrigin = process.env.PROBE_PUBLIC_ORIGIN;
  const origin = configuredOrigin === undefined ? `${forwardedProto}://${forwardedHost}` : new URL(configuredOrigin).origin;
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  return new Request(new URL(request.url ?? "/", origin), {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function loginRoute(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const returnTo = safeReturnTo(url.searchParams.get("return_to"), url.origin);
    return html(loginPage(returnTo));
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = new URLSearchParams(await request.text());
  const returnTo = safeReturnTo(form.get("return_to"), url.origin);
  if (form.get("username") !== PROBE_USERNAME || form.get("password") !== PROBE_PASSWORD) {
    return html(loginPage(returnTo, "Invalid fixture credentials."), 401);
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: returnTo,
      "set-cookie": `probe_session=${PROBE_SUBJECT}; Path=/; HttpOnly; SameSite=Lax`,
    },
  });
}

function loginPage(returnTo: string, error?: string): string {
  return page("ENG-277 fixture login", `
    <h1>Sign in to the ENG-277 probe</h1>
    <p>This local fixture account exists only for the live MCP client check.</p>
    ${error === undefined ? "" : `<p class="error">${escapeHtml(error)}</p>`}
    <form method="post" action="/fixture/login">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <label>Username <input name="username" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>`);
}

function consentPage(url: URL, clientName: string, scopes: string[]): string {
  const hidden = [...url.searchParams.entries()]
    .filter(([name]) => name !== "probe_consent")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  return page("Authorize ENG-277 probe", `
    <h1>Allow ${escapeHtml(clientName)}?</h1>
    <p>The client requests: <strong>${escapeHtml(scopes.join(" ") || "default access")}</strong>.</p>
    <p>Approval exposes only the self-contained probe and generated-component fixture.</p>
    <form method="get" action="${escapeHtml(url.pathname)}">
      ${hidden}
      <input type="hidden" name="probe_consent" value="allow">
      <button type="submit">Allow connector</button>
    </form>`);
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui;max-width:680px;margin:60px auto;padding:0 24px}form{display:grid;gap:16px}label{display:grid;gap:6px;font-weight:700}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #888}button{font-weight:800;background:#111;color:#fff}.error{color:#b00020;font-weight:700}</style></head><body>${content}</body></html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function firstHeader(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function readCookie(header: string | null, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim().split("=")).find(([key]) => key === name)?.slice(1).join("=");
}

function safeReturnTo(value: string | null, origin: string): string {
  if (!value) return `${origin}${REAL_DOOR_MOUNT}/authorize`;
  const target = new URL(value, origin);
  if (target.origin !== origin || target.pathname !== `${REAL_DOOR_MOUNT}/authorize`) {
    return `${origin}${REAL_DOOR_MOUNT}/authorize`;
  }
  return target.href;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? "3210", 10);
  const stack = await createProbeStack({ port });
  console.log(`ENG-277 probe stack ready at ${stack.origin}`);
  console.log(`standalone capability probe: ${stack.probeEndpoint}`);
  console.log(`real Vendo door: ${stack.realDoorEndpoint}`);
  console.log(`fixture credentials: ${PROBE_USERNAME} / ${PROBE_PASSWORD}`);
  const stop = async () => {
    await stack.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
