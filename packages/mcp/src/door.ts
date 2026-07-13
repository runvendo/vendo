import type {
  Guard,
  Json,
  Principal,
  RunContext,
  StoreAdapter,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
} from "@vendoai/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { HostOAuthAdapter } from "./oauth/adapter.js";
import type { AppsPort } from "./apps-port.js";
import { canonicalUri, OAuthServer, sameCanonicalUri } from "./oauth/server.js";
import { SHIM_HTML } from "./shim/shim-html.gen.js";

const PRM_PREFIX = "/.well-known/oauth-protected-resource";
const AS_PREFIX = "/.well-known/oauth-authorization-server";
const SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";
const SERVER_CARD_ALIAS_PATH = "/.well-known/mcp-server-card";
const SHIM_URI = "ui://vendo/tree-shim.html";
const SHIM_MIME_TYPE = "text/html;profile=mcp-app";

interface HostIdentity {
  name: string;
  version: string;
  description: string;
}

interface SessionState {
  subject: string;
  context: McpRunContext;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  sessionId?: string;
  touchedAt: number;
}

/** A session outlives its access token only for as long as the client keeps
 * using it (every request re-authenticates). An abandoned session therefore
 * has no reason to live past the token's own lifetime — sweep it, so the
 * in-memory maps cannot grow without bound. */
const SESSION_IDLE_MS = 60 * 60 * 1000;

/** 10-mcp §1. */
export interface McpDoorConfig {
  /** ALREADY guard-bound by the umbrella (05 §2) — the door never sees an unbound registry. */
  tools: ToolRegistry;
  /** Audit reporting for auth events (§3); tool decisions happen inside the bound registry. */
  guard: Guard;
  /** §3 — two functions; the host owns identity + consent, the door owns the protocol. */
  oauth: HostOAuthAdapter;
  /** Door-owned protocol state (clients, codes, refresh grants) — wired like every other block. */
  store: StoreAdapter;
  /** §4 — saved apps ride along as MCP Apps; absent → tools-only door. */
  apps?: AppsPort;
}

export interface McpDoor {
  /** One fetch-style handler serving: MCP Streamable HTTP transport, the OAuth
   * endpoints (§3), and the discovery documents (§5). The umbrella mounts it. */
  handler: (req: Request) => Promise<Response>;
}

export function createMcpDoor(config: McpDoorConfig): McpDoor {
  const door = new Door(config);
  return { handler: (req) => door.handler(req) };
}

class Door {
  readonly #config: McpDoorConfig;
  readonly #oauth: OAuthServer;
  readonly #sessions = new Map<string, SessionState>();
  readonly #subjectSessions = new Map<string, Set<string>>();
  /** Last mount an MCP request actually arrived at — a server-card hint only.
   * Authority never derives from remembered paths: every flow re-derives its
   * mount from its own request URL, and tokens bind to the canonical resource
   * URI, so a stray probe to an odd path can neither poison discovery nor
   * mint authority for the real mount. */
  #cardMount: string | undefined;
  #identity: Promise<HostIdentity> | undefined;

  constructor(config: McpDoorConfig) {
    this.#config = config;
    this.#oauth = new OAuthServer(config);
  }

  async handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith(PRM_PREFIX)) {
      if (req.method !== "GET") return notFound();
      return json(protectedResourceMetadata(url.origin, path.slice(PRM_PREFIX.length)));
    }
    if (path.startsWith(AS_PREFIX)) {
      if (req.method !== "GET") return notFound();
      return json(authorizationServerMetadata(url.origin, path.slice(AS_PREFIX.length)));
    }
    if (path === SERVER_CARD_PATH || path === SERVER_CARD_ALIAS_PATH) {
      if (req.method !== "GET") return notFound();
      const mount = this.#cardMount ?? "/mcp";
      const identity = await this.#hostIdentity();
      // SEP-2127 remains a draft; this deliberately minimal shape tracks it.
      return json({
        name: identity.name,
        version: identity.version,
        description: identity.description,
        protocol_versions: ["2025-11-25"],
        transports: [{ type: "streamable-http", url: resourceUri(url.origin, mount) }],
        authorization: {
          type: "oauth2",
          resource_metadata: protectedResourceMetadataUrl(url.origin, mount),
        },
      });
    }

    const endpoint = endpointFor(path);
    const mount = endpoint.mount;
    if (endpoint.kind === "authorize") {
      return req.method === "GET" ? this.#oauth.authorize(req, resourceUri(url.origin, mount)) : notFound();
    }
    if (endpoint.kind === "token") {
      return req.method === "POST" ? this.#oauth.token(req) : notFound();
    }
    if (endpoint.kind === "register") {
      return req.method === "POST" ? this.#oauth.register(req) : notFound();
    }
    if (!["GET", "POST", "DELETE"].includes(req.method)) return notFound();
    return this.#handleMcp(req, mount);
  }

  async #handleMcp(req: Request, mount: string): Promise<Response> {
    const url = new URL(req.url);
    const resource = resourceUri(url.origin, mount);
    await this.#sweepIdleSessions();
    const auth = await this.#oauth.authenticate(req);
    if (!auth || !sameCanonicalUri(auth.grant.resource, resource)) {
      return unauthorized(url.origin, mount, req.headers.has("authorization"));
    }

    const requestedSessionId = req.headers.get("mcp-session-id") ?? undefined;
    const requestedState = requestedSessionId === undefined ? undefined : this.#sessions.get(requestedSessionId);
    if (requestedSessionId !== undefined && (!requestedState || requestedState.subject !== auth.grant.subject)) {
      return unknownSession();
    }

    const principal = await this.#oauth.principal(auth.grant.subject);
    if (principal === null) {
      await this.#killSubject(auth.grant.subject);
      await this.#oauth.auditRevoke(auth.grant.subject, auth.grant.clientId);
      return unauthorized(url.origin, mount, true);
    }
    // 10-mcp §2: anonymous/ephemeral principals are never served a session —
    // the door persists grants and audit and must have a durable subject.
    if (principal.ephemeral === true) {
      await this.#killSubject(auth.grant.subject);
      return unauthorized(url.origin, mount, true);
    }
    // Only authenticated traffic teaches the server card its mount — an
    // unauthenticated probe to an arbitrary path must not steer discovery.
    this.#cardMount = normalizeMount(mount);

    // The OAuth consent this authenticated request rode in on — projected onto
    // every RunContext the door mints (10-mcp §3), the evidence actions uses to
    // authenticate host execution via ActAs. The inbound bearer itself is never
    // forwarded; only this clientId/scopes projection travels.
    const consent = { clientId: auth.grant.clientId, scopes: auth.grant.scopes };

    if (requestedSessionId !== undefined) {
      requestedState!.context = mcpContext(principal, requestedSessionId, consent);
      requestedState!.touchedAt = Date.now();
      return requestedState!.transport.handleRequest(req);
    }

    const state = await this.#newSession(auth.grant.subject, principal, consent);
    const response = await state.transport.handleRequest(req);
    if (state.sessionId === undefined) await state.transport.close();
    return response;
  }

  async #newSession(
    subject: string,
    principal: Principal,
    consent: { clientId: string; scopes: string[] },
  ): Promise<SessionState> {
    const identity = await this.#hostIdentity();
    let state: SessionState;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `mcps_${randomHex(16)}`,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        state.sessionId = sessionId;
        state.context = mcpContext(state.context.principal, sessionId, consent);
        this.#sessions.set(sessionId, state);
        const sessions = this.#subjectSessions.get(subject) ?? new Set<string>();
        sessions.add(sessionId);
        this.#subjectSessions.set(subject, sessions);
      },
      onsessionclosed: (sessionId) => this.#forgetSession(subject, sessionId),
    });
    const capabilities = this.#config.apps === undefined
      ? { tools: {} }
      : {
          tools: {},
          resources: {},
          extensions: { "io.modelcontextprotocol/ui": {} },
        };
    const server = new Server(
      { name: identity.name, version: identity.version },
      { capabilities },
    );
    state = {
      subject,
      context: mcpContext(principal, `mcpr_${randomHex(16)}`, consent),
      server,
      transport,
      touchedAt: Date.now(),
    };
    this.#registerHandlers(state, identity);
    await server.connect(transport);
    return state;
  }

  #registerHandlers(state: SessionState, identity: HostIdentity): void {
    state.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await this.#listedTools(),
    }));
    state.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.#callTool(request.params.name, request.params.arguments ?? {}, state.context, identity));

    if (this.#config.apps !== undefined) {
      state.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [{
          uri: SHIM_URI,
          name: "Vendo tree renderer",
          description: "Static MCP Apps renderer for Vendo tree payloads",
          mimeType: SHIM_MIME_TYPE,
        }],
      }));
      state.server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
        contents: request.params.uri === SHIM_URI
          ? [{ uri: SHIM_URI, mimeType: SHIM_MIME_TYPE, text: SHIM_HTML }]
          : [],
      }));
    }
  }

  async #listedTools(): Promise<Tool[]> {
    const descriptors = await this.#config.tools.descriptors();
    const tools: Tool[] = descriptors.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: inputSchema as Tool["inputSchema"],
    }));
    // The bound registry is verbatim and always wins (10-mcp §2); the door's
    // ride-along tools are additions only — a same-named registry tool (e.g.
    // vendo_apps_open from apps.agentTools(), if the umbrella registered it)
    // keeps its registry descriptor and its registry execution path.
    if (this.#config.apps !== undefined) {
      const taken = new Set(tools.map((tool) => tool.name));
      tools.push(...appTools().filter((tool) => !taken.has(tool.name)));
    }
    return tools;
  }

  async #callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: RunContext,
    identity: HostIdentity,
  ): Promise<CallToolResult> {
    const descriptors = await this.#config.tools.descriptors();
    if (!descriptors.some((descriptor) => descriptor.name === name)) {
      if (this.#config.apps !== undefined && APP_TOOL_NAMES.has(name)) {
        return this.#callAppsTool(name, args, ctx, identity);
      }
      return inBandError(`not-found: Tool ${name} was not found`);
    }
    const outcome = await this.#config.tools.execute({
      id: `mctc_${crypto.randomUUID()}`,
      tool: name,
      args,
    }, ctx);
    return mapOutcome(outcome, identity.name);
  }

  /** The ride-along tools are door tool calls like any other (10-mcp §2/§4).
   * The door holds the core `Guard` seam (check/report) — not `VendoGuard.bind`
   * (that's already applied to `config.tools`) — so it runs the seam's own
   * decide → (maybe park) → execute → report here: guard.check parks on "ask",
   * VendoError codes are preserved, the call is audited. Output scanning is a
   * bind-internal stage not exposed on the seam, but it still runs where it
   * matters: the forwarded host-tool ref executes inside AppsPort.call, which
   * the umbrella guard-BINDS (06 §1), under its own venue="app" context. Two
   * perimeters, one decision each; the door wrapper only adds Vendo's own
   * app-list / tree-payload envelope, which carries no host data to scan. */
  async #callAppsTool(
    name: string,
    args: Record<string, unknown>,
    ctx: RunContext,
    identity: HostIdentity,
  ): Promise<CallToolResult> {
    const descriptor = APP_TOOL_DESCRIPTORS.find((candidate) => candidate.name === name);
    if (this.#config.apps === undefined || descriptor === undefined) {
      return inBandError(`not-found: Tool ${name} was not found`);
    }
    const call = { id: `mctc_${crypto.randomUUID()}`, tool: name, args: args as Json };
    const decision = await this.#config.guard.check(call, descriptor, ctx);
    const outcome: ToolOutcome = decision.action === "block"
      ? { status: "blocked", reason: decision.reason }
      : decision.action === "ask"
        ? { status: "pending-approval", approvalId: decision.approval.id }
        : await this.#executeAppsTool(name, args, ctx);
    await this.#config.guard.report({
      id: `aud_${randomHex(12)}`,
      at: new Date().toISOString(),
      kind: "tool-call",
      principal: ctx.principal,
      venue: ctx.venue,
      presence: ctx.presence,
      tool: name,
      inputPreview: appToolPreview(name, args),
      outcome: outcome.status,
      decidedBy: decision.decidedBy,
    });
    return mapOutcome(outcome, identity.name);
  }

  async #executeAppsTool(name: string, args: Record<string, unknown>, ctx: RunContext): Promise<ToolOutcome> {
    const apps = this.#config.apps!;
    try {
      if (name === "vendo_apps_list") {
        return { status: "ok", output: await apps.list(ctx) };
      }
      const appId = typeof args.appId === "string" ? args.appId : undefined;
      if (!appId) return { status: "error", error: { code: "validation", message: "appId is required" } };
      if (name === "vendo_apps_open") {
        const opened = await apps.open(appId, ctx);
        return { status: "ok", output: opened.kind === "http" ? { url: opened.url } : opened.payload };
      }
      const ref = typeof args.ref === "string" ? args.ref : undefined;
      if (!ref) return { status: "error", error: { code: "validation", message: "ref is required" } };
      if (!Object.hasOwn(args, "args")) {
        return { status: "error", error: { code: "validation", message: "args is required" } };
      }
      return { status: "ok", output: await apps.call(appId, ref, args.args as Json, ctx) };
    } catch (error) {
      // Preserve the VendoError taxonomy (e.g. "cloud-required",
      // "sandbox-unavailable") — 00-overview's "one error taxonomy" convention.
      return { status: "error", error: { code: errorCode(error), message: errorMessage(error) } };
    }
  }

  async #sweepIdleSessions(): Promise<void> {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, state] of [...this.#sessions]) {
      if (state.touchedAt > cutoff) continue;
      this.#forgetSession(state.subject, id);
      try {
        await state.transport.close();
      } catch {
        // A transport already closing is exactly the state we want it in.
      }
    }
  }

  async #killSubject(subject: string): Promise<void> {
    const ids = [...(this.#subjectSessions.get(subject) ?? [])];
    for (const id of ids) {
      const state = this.#sessions.get(id);
      this.#forgetSession(subject, id);
      if (state) {
        try {
          await state.transport.close();
        } catch {
          // Revocation must remain fail-closed even if a transport is already closing.
        }
      }
    }
  }

  #forgetSession(subject: string, sessionId: string): void {
    this.#sessions.delete(sessionId);
    const sessions = this.#subjectSessions.get(subject);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) this.#subjectSessions.delete(subject);
  }

  #hostIdentity(): Promise<HostIdentity> {
    this.#identity ??= readHostIdentity();
    return this.#identity;
  }
}

function endpointFor(path: string): { kind: "mcp" | "authorize" | "token" | "register"; mount: string } {
  for (const [suffix, kind] of [
    ["/authorize", "authorize"],
    ["/token", "token"],
    ["/register", "register"],
  ] as const) {
    if (path.endsWith(suffix)) return { kind, mount: path.slice(0, -suffix.length) };
  }
  return { kind: "mcp", mount: path };
}

function normalizeMount(mount: string): string {
  if (!mount || mount === "/") return "";
  return `/${mount.replace(/^\/+|\/+$/g, "")}`;
}

function resourceUri(origin: string, mount: string): string {
  return canonicalUri(`${origin}${normalizeMount(mount)}`);
}

function protectedResourceMetadataUrl(origin: string, mount: string): string {
  return canonicalUri(origin) + PRM_PREFIX + normalizeMount(mount);
}

function protectedResourceMetadata(origin: string, mount: string) {
  const resource = resourceUri(origin, mount);
  return {
    resource,
    authorization_servers: [resource],
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata(origin: string, mount: string) {
  const issuer = resourceUri(origin, mount);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  };
}

function unauthorized(origin: string, mount: string, tokenPresented: boolean): Response {
  const resourceMetadata = protectedResourceMetadataUrl(origin, mount);
  const challenge = `Bearer resource_metadata="${resourceMetadata}"${tokenPresented ? ', error="invalid_token"' : ""}`;
  return json({ error: { code: "unauthorized", message: "A valid bearer token is required" } }, 401, {
    "www-authenticate": challenge,
  });
}

function unknownSession(): Response {
  return json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  }, 404);
}

function notFound(): Response {
  return json({ error: { code: "not-found", message: "Not found" } }, 404);
}

/** Door-owned descriptors for the ride-along tools — the shapes guard.check
 * decides against (risk labels apply identically, 10-mcp §2). */
const APP_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "vendo_apps_list",
    description: "List the current user's saved Vendo apps",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "vendo_apps_open",
    description: "Open a saved Vendo app",
    inputSchema: {
      type: "object",
      properties: { appId: { type: "string" } },
      required: ["appId"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "vendo_apps_call",
    description: "Run an interaction from a saved Vendo app",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        ref: { type: "string" },
        args: {},
      },
      required: ["appId", "ref", "args"],
      additionalProperties: false,
    },
    risk: "write",
  },
];

const APP_TOOL_NAMES = new Set(APP_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name));

function appTools(): Tool[] {
  // 10-mcp §4 names both vendo_apps_list and vendo_apps_open as carrying
  // _meta.ui.resourceUri; all three ride-along tools advertise the shim so the
  // host can preload it. A list result isn't a renderable payload — the shim's
  // format dispatch (core §8) contains that gracefully.
  const uiMeta = { ui: { resourceUri: SHIM_URI }, "ui/resourceUri": SHIM_URI };
  return APP_TOOL_DESCRIPTORS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema: inputSchema as Tool["inputSchema"],
    _meta: uiMeta,
  }));
}

function appToolPreview(name: string, args: Record<string, unknown>): string {
  const preview = `${name} ${stringify(args)}`;
  return preview.length > 500 ? `${preview.slice(0, 499)}…` : preview;
}

function mapOutcome(outcome: ToolOutcome, productName: string): CallToolResult {
  switch (outcome.status) {
    case "ok":
      return textResult(outcome.output);
    case "error":
      return inBandError(`${outcome.error.code}: ${outcome.error.message}`);
    case "pending-approval":
      return inBandError(
        `This action needs approval. Approval ${outcome.approvalId} is waiting in ${productName}'s Vendo approvals queue — resolve it there, then retry.`,
      );
    case "blocked":
      return inBandError(outcome.reason);
  }
}

function textResult(output: unknown): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text: stringify(output) }] };
  if (isRecord(output)) result.structuredContent = output;
  return result;
}

function inBandError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/** The RunContext the door mints for every MCP tool call. It carries the
 * door's OAuth-consent evidence structurally: `mcpConsent` is the projection of
 * the authenticated AccessGrant (10-mcp §3) — the OAuth'd user's `clientId` and
 * the scopes they consented the client to. actions reads it off the ctx to
 * authenticate host execution through the ActAs seam (04 §4) WITHOUT the door
 * ever forwarding the inbound MCP bearer. actions CANNOT import this type
 * (actions depends on core only, enforced by scripts/dependency-guard.mjs), so
 * — exactly as guard attaches `ctx.grant` for ActionsRunContext — this is a
 * STRUCTURAL contract: ActionsRunContext's optional `mcpConsent?` twin must
 * match this shape. */
export type McpRunContext = RunContext & {
  mcpConsent: { clientId: string; scopes: string[] };
};

function mcpContext(
  principal: Principal,
  sessionId: string,
  consent: { clientId: string; scopes: string[] },
): McpRunContext {
  return { principal, venue: "mcp", presence: "present", sessionId, mcpConsent: consent };
}

async function readHostIdentity(): Promise<HostIdentity> {
  const fallback = { name: "vendo", version: "0.0.0", description: "Vendo MCP server" };
  try {
    if (typeof process === "undefined") return fallback;
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(`${process.cwd()}/package.json`, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof pkg.name === "string" ? pkg.name : fallback.name;
    const version = typeof pkg.version === "string" ? pkg.version : fallback.version;
    const description = typeof pkg.description === "string" ? pkg.description : `${name} MCP server`;
    return { name, version, description };
  } catch {
    return fallback;
  }
}

function randomHex(byteLength: number): string {
  return [...crypto.getRandomValues(new Uint8Array(byteLength))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "error";
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
