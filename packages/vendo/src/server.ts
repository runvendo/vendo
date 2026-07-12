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
import { createStore, envSecrets, type VendoStore } from "@vendoai/store";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";
import { createRequire } from "node:module";
import type { LanguageModel } from "ai";

const VERSION = "0.3.0";
const BASE_PATH = "/api/vendo";

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
    composition works without them; on non-Node runtimes they just stay unset). */
function dotVendoFile(name: string): string | undefined {
  try {
    const nodeRequire = createRequire(import.meta.url);
    const { readFileSync } = nodeRequire("node:fs") as typeof import("node:fs");
    return readFileSync(`.vendo/${name}`, "utf8");
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
      deps.onRequestOrigin?.(url.origin);
      const path = relativePath(url);
      if (path === null) throw new VendoError("not-found", "unknown Vendo route");
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
        return json(await deps.guard.audit.query({
          principal: ctx.principal,
          ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
          ...(limit === undefined ? {} : { limit }),
        }));
      }
      if (request.method === "GET" && path === "/status") {
        await context(request, "chat");
        return json({
          posture: deps.guard.status().posture,
          version: VERSION,
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
  // createActions reads baseUrl from this object at execution time; when
  // VENDO_BASE_URL is unset, the handler fills it in from the first request's
  // origin so route bindings execute same-origin with zero configuration.
  const actionsConfig = {
    dir: ".",
    ...(config.connectors === undefined ? {} : { connectors: config.connectors }),
    ...(config.actAs === undefined ? {} : { actAs: config.actAs }),
    ...(environment("VENDO_BASE_URL") === undefined ? {} : { baseUrl: environment("VENDO_BASE_URL") }),
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
    onRequestOrigin: (origin) => {
      // Same-origin default for route-binding execution (04): no VENDO_BASE_URL
      // → the wire's own origin, learned from the first request and then fixed.
      actionsConfig.baseUrl ??= origin;
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
