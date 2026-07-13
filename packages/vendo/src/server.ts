import { createActions, type ActionsRegistry, type Connector } from "@vendoai/actions";
import { createAgent, type VendoAgent } from "@vendoai/agent";
import { createApps, type AppsRuntime, type SandboxAdapter } from "@vendoai/apps";
import {
  createAutomations,
  type AutomationsEngine,
  type RunStatus,
} from "@vendoai/automations";
import {
  VendoError,
  approvalDecisionSchema,
  principalSchema,
  vendoThemeSchema,
  type ActAs,
  type ApprovalDecision,
  type Json,
  type Principal,
  type RunContext,
  type RunId,
  type SecretsProvider,
  type VendoErrorCode,
  type VendoTheme,
} from "@vendoai/core";
import { createGuard, type Judge, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createMcpDoor, type AppsPort, type HostOAuthAdapter, type McpDoor } from "@vendoai/mcp";
import { createStore, envSecrets, type VendoStore } from "@vendoai/store";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";
import type { LanguageModel } from "ai";

const VERSION = "0.3.0";
const BASE_PATH = "/api/vendo";
/** 10-mcp §5 — the door's canonical mount under the wire's own prefix. */
const MCP_MOUNT = `${BASE_PATH}/mcp`;

const STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
};

export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  agent: VendoAgent;
  guard: VendoGuard;
  apps: AppsRuntime;
  automations: AutomationsEngine;
  actions: ActionsRegistry;
  store: VendoStore;
}

export interface CreateVendoConfig {
  model: LanguageModel;
  principal: (req: Request) => Promise<Principal | null>;
  store?: VendoStore;
  sandbox?: SandboxAdapter;
  connectors?: Connector[];
  actAs?: ActAs;
  policy?: PolicyConfig;
  judge?: Judge;
  secrets?: SecretsProvider;
  telemetry?: boolean;
  /** 10-mcp §1 — the one flag: open the MCP door so outside agents (Claude,
      ChatGPT, Cursor) reach the host's tools through the SAME guard-bound path.
      Opening it is a host decision (10-mcp §2), so it is off by default. */
  mcp?: boolean;
  /** 10-mcp §3 — the host's identity + consent seam. Threaded top-level like
      `actAs`/`principal` (the door is agnostic; the umbrella owns the shape).
      REQUIRED when `mcp` is true: the door cannot mint principals without it. */
  oauth?: HostOAuthAdapter;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(error: VendoError): Response {
  return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
}

function internalError(): Response {
  return errorResponse(new VendoError("not-implemented", "Internal Vendo error"));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VendoError("validation", `${label} must be a non-empty string`);
  }
  return value;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return object(await request.json(), "request body");
  } catch (error) {
    if (error instanceof VendoError) throw error;
    throw new VendoError("validation", "request body must be valid JSON");
  }
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    === "application/json";
}

function environment(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 09 §4 — the .vendo/ files feeding the generation seat, read fail-soft (the
    composition works without them; on non-Node runtimes they just stay unset).
    Reads `node:fs` through the runtime built-in accessor so this module carries
    NO static Node import and still loads/bundles for edge/Worker targets. */
function dotVendoFile(name: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
    if (fs === undefined) return undefined;
    return fs.readFileSync(`.vendo/${name}`, "utf8");
  } catch {
    return undefined;
  }
}

function dotVendoTheme(): VendoTheme | undefined {
  const raw = dotVendoFile("theme.json");
  if (raw === undefined) return undefined;
  try {
    const parsed = vendoThemeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function relativePath(url: URL): string | null {
  if (url.pathname === BASE_PATH) return "/";
  if (!url.pathname.startsWith(`${BASE_PATH}/`)) return null;
  return url.pathname.slice(BASE_PATH.length);
}

/** 10-mcp §4-5 — the three path families the door owns: its own mount, and the
    origin-root discovery documents it serves (RFC 9728 path-inserted metadata +
    the SEP-2127 server card). These are NOT wire routes — the door mints its own
    principals (§3), and the OAuth /token and /register endpoints are
    form-encoded POSTs — so they bypass the wire's principal/CSRF machinery. */
function isDoorPath(pathname: string): boolean {
  if (pathname === MCP_MOUNT || pathname.startsWith(`${MCP_MOUNT}/`)) return true;
  return (
    pathname.startsWith("/.well-known/oauth-protected-resource")
    || pathname.startsWith("/.well-known/oauth-authorization-server")
    || pathname === "/.well-known/mcp/server-card.json"
    || pathname === "/.well-known/mcp-server-card"
  );
}

function routeSegments(path: string): string[] {
  try {
    return path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new VendoError("validation", "route contains invalid URL encoding");
  }
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

function jsonMutationRequired(request: Request, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  if (path === "/apps/import" || path === "/tick" || path.startsWith("/webhooks/")) return false;
  return true;
}

function tickAuthorized(request: Request): boolean {
  const secret = environment("VENDO_TICK_SECRET");
  if (secret === undefined) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function ephemeralPrincipal(subject: string): Principal {
  return { kind: "user", subject, ephemeral: true };
}

function telemetryClient(enabled: boolean | undefined): Telemetry | undefined {
  if (enabled !== true) return undefined;
  try {
    return initTelemetry({ version: VERSION, runtime: true });
  } catch {
    return undefined;
  }
}

function createWireHandler(deps: {
  principal: CreateVendoConfig["principal"];
  ready: Promise<void>;
  anonymous: Principal;
  sessionId: string;
  telemetry?: Telemetry;
  agent: VendoAgent;
  guard: VendoGuard;
  apps: AppsRuntime;
  automations: AutomationsEngine;
  mcp: boolean;
  door?: McpDoor;
  onRequestOrigin?: (origin: string) => void;
}): (request: Request) => Promise<Response> {
  const context = async (request: Request, venue: RunContext["venue"]): Promise<RunContext> => {
    const resolved = await deps.principal(request);
    let principal: Principal;
    if (resolved === null) {
      principal = deps.anonymous;
    } else {
      const parsed = principalSchema.safeParse(resolved);
      if (!parsed.success) {
        throw new VendoError("validation", "principal resolver returned an invalid principal");
      }
      principal = parsed.data;
    }
    return {
      principal,
      venue,
      presence: "present",
      sessionId: request.headers.get("x-vendo-session-id") ?? deps.sessionId,
      requestHeaders: requestHeaders(request),
    };
  };

  return async (request) => {
    try {
      const url = new URL(request.url);
      // 10-mcp: hand the door its own paths BEFORE any wire machinery. It runs
      // ahead of relativePath's not-found rejection (the origin-root discovery
      // documents fall outside BASE_PATH) and ahead of the CSRF json-mutation
      // gate (OAuth /token and /register are form-encoded POSTs, not JSON). The
      // door authenticates every request through oauth.principal (§3), so the
      // wire's principal resolver never runs for it — and, deliberately, these
      // requests do NOT teach the same-origin baseUrl default: only a request
      // addressing a real Vendo WIRE route may (04 §4), and the door's paths are
      // the door's, not wire routes.
      if (deps.door !== undefined && isDoorPath(url.pathname)) {
        await deps.ready;
        return await deps.door.handler(request);
      }
      const path = relativePath(url);
      if (path === null) throw new VendoError("not-found", "unknown Vendo route");
      // Learn the same-origin default only from a request that addresses a real
      // Vendo route (defense in depth beyond the untrusted-forwarding rule).
      deps.onRequestOrigin?.(url.origin);
      if (jsonMutationRequired(request, path) && !isJsonRequest(request)) {
        throw new VendoError("validation", "content-type must be application/json");
      }
      await deps.ready;

      if (request.method === "POST" && path.startsWith("/webhooks/")) {
        return await deps.automations.webhook(request);
      }
      if (request.method === "POST" && path === "/tick") {
        if (!tickAuthorized(request)) {
          return json({ error: { code: "blocked", message: "invalid tick credential" } }, 401);
        }
        return json({ runIds: await deps.automations.tick() });
      }
      if (path.startsWith("/proxy/")) {
        const proxyPath = path.slice("/proxy".length);
        const proxyUrl = new URL(request.url);
        proxyUrl.pathname = proxyPath;
        return await deps.apps.proxy.handler(new Request(proxyUrl, request));
      }

      const segments = routeSegments(path);
      const head = segments[0];

      if (request.method === "POST" && path === "/threads") {
        const body = await requestJson(request);
        const ctx = await context(request, "chat");
        void deps.telemetry?.track("agent_run", {});
        return await deps.agent.stream({
          ...(body["threadId"] === undefined ? {} : { threadId: string(body["threadId"], "threadId") }),
          message: body["message"] as never,
          ctx,
        });
      }
      if (request.method === "GET" && path === "/threads") {
        return json(await deps.agent.threads.list(await context(request, "chat")));
      }
      if (head === "threads" && segments.length === 2) {
        const ctx = await context(request, "chat");
        const id = string(segments[1], "thread id");
        if (request.method === "GET") {
          const thread = await deps.agent.threads.get(id, ctx);
          if (thread === null) throw new VendoError("not-found", `thread not found: ${id}`);
          return json(thread);
        }
        if (request.method === "DELETE") {
          await deps.agent.threads.delete(id, ctx);
          return json({});
        }
      }

      if (request.method === "GET" && path === "/approvals") {
        const ctx = await context(request, "chat");
        return json(await deps.guard.approvals.pending(ctx.principal));
      }
      if (request.method === "POST" && path === "/approvals/decide") {
        const body = await requestJson(request);
        const ids = Array.isArray(body["ids"]) ? body["ids"].map((id) => string(id, "approval id")) : [];
        if (ids.length === 0) throw new VendoError("validation", "ids must contain at least one approval id");
        const decision = approvalDecisionSchema.safeParse(body["decision"]);
        if (!decision.success) throw new VendoError("validation", "decision is invalid");
        const ctx = await context(request, "chat");
        await deps.guard.approvals.decide(ids, decision.data as ApprovalDecision, ctx.principal);
        return json({});
      }

      if (request.method === "GET" && path === "/grants") {
        const ctx = await context(request, "chat");
        return json(await deps.guard.grants.list(ctx.principal));
      }
      if (request.method === "DELETE" && head === "grants" && segments.length === 2) {
        const ctx = await context(request, "chat");
        await deps.guard.grants.revoke(string(segments[1], "grant id"), ctx.principal);
        return json({});
      }

      if (path === "/apps") {
        const ctx = await context(request, "app");
        if (request.method === "GET") return json(await deps.apps.list(ctx));
        if (request.method === "POST") {
          const body = await requestJson(request);
          return json(await deps.apps.create({ prompt: string(body["prompt"], "prompt") }, ctx));
        }
      }
      if (request.method === "POST" && path === "/apps/import") {
        // The CSRF floor exempts import (binary body), so it must instead require
        // a non-CORS-safelisted media type — forcing a cross-origin preflight so
        // a simple credentialed form/text POST cannot silently import (09 §3).
        const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/octet-stream" && contentType !== "application/vnd.vendo.app") {
          throw new VendoError("validation", "import requires Content-Type: application/octet-stream");
        }
        const ctx = await context(request, "app");
        return json(await deps.apps.importApp(new Uint8Array(await request.arrayBuffer()), ctx));
      }
      if (head === "apps" && segments.length >= 2) {
        const appId = string(segments[1], "app id");
        const ctx = await context(request, "app");
        if (segments.length === 2) {
          if (request.method === "GET") {
            const app = await deps.apps.get(appId, ctx);
            if (app === null) throw new VendoError("not-found", `app not found: ${appId}`);
            return json(app);
          }
          if (request.method === "DELETE") {
            await deps.apps.delete(appId, ctx);
            return json({});
          }
        }
        const operation = segments[2];
        if (request.method === "GET" && operation === "open" && segments.length === 3) {
          return json(await deps.apps.open(appId, ctx));
        }
        if (request.method === "POST" && operation === "call" && segments.length === 3) {
          const body = await requestJson(request);
          return json(await deps.apps.call(appId, string(body["ref"], "ref"), body["args"] as Json, ctx));
        }
        if (request.method === "POST" && operation === "edit" && segments.length === 3) {
          const body = await requestJson(request);
          return json(await deps.apps.edit(appId, string(body["instruction"], "instruction"), ctx));
        }
        if (operation === "history" && segments.length === 3) {
          if (await deps.apps.get(appId, ctx) === null) throw new VendoError("not-found", `app not found: ${appId}`);
          if (request.method === "GET") return json(await deps.apps.history(appId).list());
          if (request.method === "POST") {
            const body = await requestJson(request);
            if (body["op"] !== "undo") throw new VendoError("validation", "history op must be undo");
            return json(await deps.apps.history(appId).undo());
          }
        }
        if (request.method === "GET" && operation === "export" && segments.length === 3) {
          const bytes = await deps.apps.exportApp(appId, ctx);
          return new Response(bytes as BodyInit, {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${appId}.vendoapp"`,
            },
          });
        }
        if (request.method === "POST" && operation === "fork" && segments.length === 3) {
          return json(await deps.apps.fork(appId, ctx));
        }
      }

      if (request.method === "GET" && path === "/automations") {
        return json(await deps.automations.list(await context(request, "automation")));
      }
      if (head === "automations" && segments.length === 3 && request.method === "POST") {
        const ctx = await context(request, "automation");
        const appId = string(segments[1], "app id");
        if (segments[2] === "enable") return json(await deps.automations.enable(appId, ctx));
        if (segments[2] === "disable") {
          await deps.automations.disable(appId, ctx);
          return json({});
        }
        if (segments[2] === "dry-run") return json(await deps.automations.dryRun(appId, ctx));
      }

      if (request.method === "GET" && path === "/runs") {
        const status = url.searchParams.get("status") ?? undefined;
        const allowed: RunStatus[] = ["running", "ok", "error", "stopped", "pending-approval"];
        if (status !== undefined && !allowed.includes(status as RunStatus)) {
          throw new VendoError("validation", "run status is invalid");
        }
        const filter = {
          ...(url.searchParams.get("appId") === null ? {} : { appId: url.searchParams.get("appId")! }),
          ...(status === undefined ? {} : { status: status as RunStatus }),
          ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
        };
        return json(await deps.automations.runs.list(filter, await context(request, "automation")));
      }
      if (head === "runs" && segments.length >= 2) {
        const ctx = await context(request, "automation");
        const runId = string(segments[1], "run id");
        if (request.method === "GET" && segments.length === 2) {
          const run = await deps.automations.runs.get(runId, ctx);
          if (run === null) throw new VendoError("not-found", `run not found: ${runId}`);
          return json(run);
        }
        if (request.method === "POST" && segments[2] === "stop" && segments.length === 3) {
          await deps.automations.runs.stop(runId, ctx);
          return json({});
        }
      }

      if (request.method === "GET" && path === "/activity") {
        const ctx = await context(request, "chat");
        const limitValue = url.searchParams.get("limit");
        const limit = limitValue === null ? undefined : Number(limitValue);
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          throw new VendoError("validation", "activity limit must be a positive integer");
        }
        const activity = await deps.guard.audit.query({
          principal: ctx.principal,
          ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
          ...(limit === undefined ? {} : { limit }),
        });
        // 09 §3: the wire returns AuditEvent[] — the block's {events,cursor}
        // envelope stays internal (the client pages by last event id).
        return json(activity.events);
      }
      if (request.method === "GET" && path === "/status") {
        await context(request, "chat");
        return json({
          posture: deps.guard.status().posture,
          version: VERSION,
          mcp: deps.mcp,
          blocks: {
            store: true,
            agent: true,
            actions: true,
            guard: true,
            apps: true,
            automations: true,
          },
        });
      }

      throw new VendoError("not-found", "unknown Vendo route");
    } catch (error) {
      if (error instanceof VendoError) return errorResponse(error);
      return internalError();
    }
  };
}

/** 09-vendo §2 — compose every live block around the guard choke point. */
export function createVendo(config: CreateVendoConfig): Vendo {
  const store = config.store ?? createStore();
  const ready = store.ensureSchema();
  // Keep eager schema readiness for hosts that reach into composed blocks,
  // while preventing an unhandled rejection before the first handler/emit awaits it.
  void ready.catch(() => undefined);
  const guard = createGuard({
    store,
    ...(config.policy === undefined ? {} : { policy: config.policy }),
    ...(config.judge === undefined ? {} : { judge: config.judge }),
  });
  // createActions reads baseUrl from this object at execution time. An explicit
  // VENDO_BASE_URL is a trusted, operator-set origin (credentials forward to it).
  // When unset, the handler learns the wire's own origin from a validated
  // request so route bindings execute same-origin with zero configuration — but
  // that learned origin is UNTRUSTED (baseUrlTrusted:false), so a spoofed Host
  // can never turn it into a credential-exfiltration target (04 §4).
  const configuredBaseUrl = environment("VENDO_BASE_URL");
  const actionsConfig: {
    dir: string;
    connectors?: Connector[];
    actAs?: ActAs;
    baseUrl?: string;
    baseUrlTrusted?: boolean;
  } = {
    dir: ".",
    ...(config.connectors === undefined ? {} : { connectors: config.connectors }),
    ...(config.actAs === undefined ? {} : { actAs: config.actAs }),
    ...(configuredBaseUrl === undefined ? {} : { baseUrl: configuredBaseUrl, baseUrlTrusted: true }),
  };
  const actions = createActions(actionsConfig);
  const boundTools = guard.bind(actions);
  const theme = dotVendoTheme();
  const designRules = dotVendoFile("design-rules.md");
  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    model: config.model,
    catalog: [],
    ...(theme === undefined ? {} : { theme }),
    ...(designRules === undefined ? {} : { designRules }),
    secrets: config.secrets ?? envSecrets(),
    ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }),
    ...(environment("VENDO_PROXY_URL") === undefined ? {} : { proxyUrl: environment("VENDO_PROXY_URL") }),
  });
  actions.add(apps.agentTools());
  const agent = createAgent({ model: config.model, tools: boundTools, guard, store });
  const automations = createAutomations({
    apps,
    tools: boundTools,
    guard,
    store,
    runner: agent.asRunner(),
  });
  // 10-mcp §1 — construct the door from the parts already assembled: the SAME
  // guard-bound registry chat/apps/automations use, the guard (its core seam is
  // what the door holds for auth audit), the store (a StoreAdapter for the door's
  // own protocol state), the host's oauth seam, and an AppsPort view of `apps`.
  let door: McpDoor | undefined;
  if (config.mcp === true) {
    if (config.oauth === undefined) {
      throw new VendoError(
        "validation",
        "createVendo({ mcp: true }) requires an `oauth` HostOAuthAdapter (10-mcp §3): the door mints door principals through it and cannot open without one.",
      );
    }
    // AppsRuntime.open adds a "resuming" variant AppsPort (tree | http) does not
    // carry. The door is a viewer + runner (10-mcp §4), so a server app still
    // waking up has no surface to hand back over MCP — signal it as an in-band
    // tool error (the door catches VendoError and preserves the code).
    const appsPort: AppsPort = {
      list: (ctx) => apps.list(ctx),
      async open(appId, ctx) {
        const opened = await apps.open(appId, ctx);
        if (opened.kind === "tree") return { kind: "tree", payload: opened.payload };
        if (opened.kind === "http") return { kind: "http", url: opened.url };
        throw new VendoError(
          "not-implemented",
          "This is a server app resuming in-product; open it in the host to use it over MCP.",
        );
      },
      call: (appId, ref, args, ctx) => apps.call(appId, ref, args, ctx),
    };
    door = createMcpDoor({ tools: boundTools, guard, store, oauth: config.oauth, apps: appsPort });
  }
  const sessionId = `session_${globalThis.crypto.randomUUID()}`;
  const anonymous = ephemeralPrincipal(`anonymous_${globalThis.crypto.randomUUID()}`);
  const handler = createWireHandler({
    principal: config.principal,
    ready,
    anonymous,
    sessionId,
    telemetry: telemetryClient(config.telemetry),
    agent,
    guard,
    apps,
    automations,
    mcp: config.mcp === true,
    ...(door === undefined ? {} : { door }),
    onRequestOrigin: (origin) => {
      // Same-origin default for route-binding execution (04): no VENDO_BASE_URL
      // → the wire's own origin, learned from the first VALIDATED request and
      // then fixed. Marked untrusted so credentials never forward to it.
      if (actionsConfig.baseUrl === undefined) {
        actionsConfig.baseUrl = origin;
        actionsConfig.baseUrlTrusted = false;
      }
    },
  });

  return {
    handler,
    async emit(event, payload, principal) {
      await ready;
      return automations.emit(event, payload, principal);
    },
    agent,
    guard,
    apps,
    automations,
    actions,
    store,
  };
}

/** 09-vendo §2 — adapt the fetch handler to a Next.js catch-all route module. */
export function nextVendoHandler(vendo: Vendo): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
} {
  const handle = (request: Request): Promise<Response> => vendo.handler(request);
  return { GET: handle, POST: handle, DELETE: handle };
}
