/** The REAL backends for the browser leg, booted ONCE inside the Vite config
 * (Vite executes this TS natively — the packages/ui harness proves the pattern).
 *
 *   1. the fixture host app (`next dev`, its OWN FIXTURE_DIST_DIR so it can run
 *      beside the sibling e2e suites under turbo without a dev-server lock fight),
 *   2. the REAL composed umbrella — `createVendo` from `@vendoai/vendo/server` —
 *      backed by a temp-dir PGlite store, reading host tools + policy from the
 *      package's own committed `.vendo/` files (cwd), with route bindings pointed
 *      at the booted host app via VENDO_BASE_URL (trusted-origin present forward)
 *      and its MCP door enabled through a real HostOAuthAdapter,
 *   3. a loopback node:http wire server that serves `vendo.handler` on the FULL
 *      `/api/vendo/...` path (self-routing — the URL is forwarded verbatim, never
 *      mount-relative) plus a small, obviously test-only control surface.
 *
 * Because Playwright's tests run in a different process from the model, the
 * control surface (`/__test/*`) lets a spec enqueue scripted model turns, reset,
 * and read authenticated host state before/while it drives the page. The Vite dev
 * server proxies `/api/vendo` and `/__test` to this origin so the page's default
 * same-origin baseUrl just works.
 *
 * PRESENT-call auth: the browser can't set a `cookie` header (forbidden) but it
 * CAN send `x-vendo-test-user`. The wire server reads that principal header,
 * logs the subject into the host app, and injects the resulting session cookie
 * onto the forwarded request — so the composed actions layer forwards it to the
 * host exactly as the node harness's `wireFetch` does (04 §4 present forwarding).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { descriptorHash, type Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { createVendo } from "@vendoai/vendo/server";
import { connectWithSdk, type ConnectedClient } from "../../../mcp-e2e/src/support.ts";
import {
  MCP_APPS_FIXTURE_ID,
  MCP_APPS_INVOICE_ID,
  MCP_APPS_SUBJECT,
  mcpBrowserFixture,
} from "./mcp-fixture.ts";
import { createControllableModel, expandTurn, type TurnSpec } from "./model.ts";

const WIRE_BASE = "/api/vendo";
const CONTROL_BASE = "/__test";
const hostDir = fileURLToPath(new URL("../../../host-app/", import.meta.url));
const nextBin = join(hostDir, "node_modules", ".bin", "next");

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      probe.off("error", reject);
      resolve();
    });
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

export interface Backends {
  /** The wire origin the Vite proxy targets. */
  wireUrl: string;
  close(): Promise<void>;
}

export async function startBackends(): Promise<Backends> {
  // --- 1. the fixture host app --------------------------------------------
  const hostPort = await freePort();
  const hostBaseUrl = `http://127.0.0.1:${hostPort}`;
  let hostOutput = "";
  const host: ChildProcessWithoutNullStreams = spawn(nextBin, ["dev", "-p", String(hostPort)], {
    cwd: hostDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FIXTURE_DIST_DIR: ".next/integration-browser" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const record = (chunk: unknown) => {
    hostOutput = `${hostOutput}${String(chunk)}`.slice(-20_000);
  };
  host.stdout.on("data", record);
  host.stderr.on("data", record);

  const deadline = Date.now() + 180_000;
  for (;;) {
    if (host.exitCode !== null) throw new Error(`host app exited early (${host.exitCode})\n${hostOutput}`);
    try {
      if ((await fetch(hostBaseUrl)).ok) break;
    } catch {
      // Next is still compiling.
    }
    if (Date.now() > deadline) throw new Error(`host app did not become ready\n${hostOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // --- 2. the composed umbrella -------------------------------------------
  // Trusted-origin branch: an explicit VENDO_BASE_URL means present-call
  // credentials forward to the host app. Set BEFORE createVendo reads it.
  process.env.VENDO_BASE_URL = hostBaseUrl;
  process.env.VENDO_TICK_SECRET ??= "integration-browser-tick-secret";

  const cookieCache = new Map<string, string>();
  const loginCookie = async (subject: string): Promise<string> => {
    const cached = cookieCache.get(subject);
    if (cached !== undefined) return cached;
    const response = await fetch(`${hostBaseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: subject }),
    });
    if (!response.ok) throw new Error(`host login failed (${response.status})`);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("host login did not return a cookie");
    cookieCache.set(subject, cookie);
    return cookie;
  };
  // Next compiles route modules lazily. Warm the exact dynamic invoice module
  // used by both existing and MCP Apps journeys before Playwright's clock starts,
  // so the e2e measures the protocol/action path rather than first-compile time.
  const warmCookie = await loginCookie(MCP_APPS_SUBJECT);
  const warmInvoice = await fetch(`${hostBaseUrl}/api/invoices/${MCP_APPS_INVOICE_ID}`, {
    headers: { cookie: warmCookie },
  });
  if (!warmInvoice.ok) throw new Error(`host invoice warmup failed (${warmInvoice.status})`);

  const dataDir = await mkdtemp(join(tmpdir(), "vendo-integration-browser-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const scripted = createControllableModel();

  const vendo = createVendo({
    model: scripted.model,
    principal: async (req) => {
      const subject = req.headers.get("x-vendo-test-user");
      return subject ? { kind: "user", subject } : null;
    },
    store,
    actAs: async (principal: Principal) => ({ headers: { cookie: await loginCookie(principal.subject) } }),
    policy: { file: ".vendo/policy.json" },
    mcp: true,
    oauth: {
      async authorize() {
        return { subject: MCP_APPS_SUBJECT };
      },
      async principal(subject) {
        return subject === MCP_APPS_SUBJECT ? { kind: "user", subject } : null;
      },
    },
  });
  await store.records("vendo_apps").put({
    id: mcpBrowserFixture.id,
    data: { subject: MCP_APPS_SUBJECT, enabled: false, doc: mcpBrowserFixture },
    refs: { subject: MCP_APPS_SUBJECT },
  });
  const originalDescriptions = new Map(
    (await vendo.actions.descriptors()).map((descriptor) => [descriptor.name, descriptor.description]),
  );

  // --- 3. the loopback wire + control server ------------------------------
  let wireUrl: string | undefined;
  let connectedMcp: ConnectedClient | undefined;
  let connectingMcp: Promise<ConnectedClient> | undefined;

  async function mcpConnection(): Promise<ConnectedClient> {
    if (connectedMcp !== undefined) return connectedMcp;
    if (wireUrl === undefined) throw new Error("wire server is not listening yet");
    connectingMcp ??= connectWithSdk({ endpoint: `${wireUrl}${WIRE_BASE}/mcp` });
    try {
      connectedMcp = await connectingMcp;
      return connectedMcp;
    } finally {
      connectingMcp = undefined;
    }
  }

  const httpServer = createHttpServer((req, res) => {
    void handle(req, res).catch((error) => {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain");
      res.end(error instanceof Error ? error.message : "wire bridge failed");
    });
  });

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith(CONTROL_BASE)) return control(req, res, url);
    if (url.pathname.startsWith("/.well-known/")) return wire(req, res);
    if (url.pathname === WIRE_BASE || url.pathname.startsWith(`${WIRE_BASE}/`)) return wire(req, res);
    res.statusCode = 404;
    res.end("not found");
  }

  // The control surface is obviously test-only: enqueue scripted turns, reset,
  // and read authenticated host state. It is NEVER mounted in product.
  async function control(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sub = url.pathname.slice(CONTROL_BASE.length);
    const respond = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && sub === "/reset") {
      scripted.reset();
      await fetch(`${hostBaseUrl}/fixture/reset`, { method: "POST" });
      for (const descriptor of await vendo.actions.descriptors()) {
        const original = originalDescriptions.get(descriptor.name);
        if (original !== undefined) descriptor.description = original;
      }
      return respond({ ok: true });
    }
    if (req.method === "POST" && sub === "/script") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { turns?: TurnSpec[] };
      const turns = Array.isArray(body.turns) ? body.turns : [];
      scripted.enqueue(turns.map(expandTurn));
      return respond({ ok: true, enqueued: turns.length });
    }
    if (req.method === "POST" && sub === "/descriptor-drift") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { tool?: unknown };
      const descriptor = (await vendo.actions.descriptors()).find(
        (candidate) => candidate.name === body.tool,
      );
      if (descriptor === undefined) return respond({ error: "unknown tool" }, 404);
      const staleHash = descriptorHash(descriptor);
      descriptor.description = `${originalDescriptions.get(descriptor.name) ?? descriptor.description} (descriptor v2)`;
      return respond({ ok: true, staleHash, currentHash: descriptorHash(descriptor) });
    }
    if (req.method === "POST" && sub === "/mcp/open") {
      const { client } = await mcpConnection();
      const listed = await client.listTools();
      const descriptor = listed.tools.find((tool) => tool.name === "vendo_apps_open");
      if (descriptor === undefined) return respond({ error: "vendo_apps_open descriptor missing" }, 500);
      const resourceUri = getToolUiResourceUri(descriptor);
      if (resourceUri === undefined) return respond({ error: "vendo_apps_open UI resource missing" }, 500);

      const toolInput = { arguments: { appId: MCP_APPS_FIXTURE_ID } };
      const toolResult = await client.callTool({ name: "vendo_apps_open", ...toolInput });
      if (toolResult.isError === true) return respond({ error: "vendo_apps_open failed", toolResult }, 500);
      const resource = await client.readResource({ uri: resourceUri });
      const content = resource.contents[0];
      if (content === undefined || !("text" in content)) {
        return respond({ error: "shim resource did not contain HTML text" }, 500);
      }
      return respond({
        appId: MCP_APPS_FIXTURE_ID,
        resourceUri,
        mimeType: content.mimeType,
        html: content.text,
        toolInput,
        toolResult,
      });
    }
    if (req.method === "POST" && sub === "/mcp/call") {
      const params = JSON.parse((await readBody(req)).toString("utf8") || "{}") as CallToolRequest["params"];
      const { client } = await mcpConnection();
      return respond(await client.callTool(params));
    }
    if (req.method === "GET" && sub === "/mcp/evidence") {
      const raw = store.raw() as { query(query: string): Promise<{ rows: unknown[] }> };
      const rows = (await raw.query(
        "SELECT tool, venue, app_id FROM vendo_audit WHERE kind = 'tool-call' ORDER BY at ASC",
      )).rows;
      return respond({ rows });
    }
    const invoice = /^\/host\/invoice\/(.+)$/.exec(sub);
    if (req.method === "GET" && invoice) {
      const response = await fetch(`${hostBaseUrl}/api/invoices/${invoice[1]}`, {
        headers: { cookie: await loginCookie("user_ada") },
      });
      const payload = response.ok ? await response.json() as { invoice?: unknown } : undefined;
      return respond({
        exists: response.status === 200,
        ...(payload?.invoice === undefined ? {} : { invoice: payload.invoice }),
      });
    }
    return respond({ error: "unknown control route" }, 404);
  }

  // Forward the FULL /api/vendo/... path verbatim to the self-routing handler.
  async function wire(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    // Present-call auth: inject the host session cookie for the named principal
    // so the composed actions layer forwards it to the host (04 §4).
    const subject = headers.get("x-vendo-test-user");
    if (subject) headers.set("cookie", await loginCookie(subject));
    // Preserve the loopback port in the Request URL. MCP OAuth discovery derives
    // absolute metadata endpoints from this origin; dropping the port sends the
    // real SDK client to an unrelated localhost listener.
    const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      ...(body === undefined || body.length === 0 ? {} : { body: new Uint8Array(body) }),
    });
    const response = await vendo.handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("wire server did not bind a TCP port");
  wireUrl = `http://127.0.0.1:${address.port}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await connectedMcp?.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      if (host.exitCode === null) host.kill("SIGKILL");
    }
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  // Vite kills this process on teardown; make sure the next child dies with it.
  const onSignal = () => void close().finally(() => process.exit(0));
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  process.once("exit", () => { if (host.exitCode === null) host.kill("SIGKILL"); });

  return { wireUrl, close };
}
