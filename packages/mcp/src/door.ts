import type {
  Guard,
  Json,
  Principal,
  RunContext,
  StoreAdapter,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
  VendoTheme,
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
import { handleFederation } from "./oauth/federation.js";
import { RemoteAsVerifier } from "./oauth/remote-as.js";
import { canonicalUri, OAuthServer, sameCanonicalUri } from "./oauth/server.js";
import { SHIM_HTML } from "./shim/shim-html.gen.js";
import {
  InMemoryMcpDoorState,
  type McpDoorState,
  type McpRunContext,
  type McpStateSession,
} from "./state.js";

export type { McpRunContext } from "./state.js";

const PRM_PREFIX = "/.well-known/oauth-protected-resource";
const AS_PREFIX = "/.well-known/oauth-authorization-server";
const SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";
const SERVER_CARD_ALIAS_PATH = "/.well-known/mcp-server-card";
const SHIM_URI = "ui://vendo/tree-shim.html";
const SHIM_MIME_TYPE = "text/html;profile=mcp-app";
const OPEN_IN_PRODUCT_KIND = "vendo/open-in-product@1";
const SHIM_THEME_MARKER = "<!--VENDO_MCP_THEME-->";

interface HostIdentity {
  name: string;
  version: string;
  description: string;
}

interface SessionState extends McpStateSession {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  sessionId?: string;
}

/** Caps replay state so a client hammering distinct parking calls in one
 * context cannot grow it without bound; the whole scope dies with its session. */
const REPLAY_CAP = 256;

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
  /** §3 — the host owns session/principal lookup; the door can own consent too. */
  oauth: HostOAuthAdapter;
  /** Door-owned protocol state (clients, codes, refresh grants) — wired like every other block. */
  store: StoreAdapter;
  /** §4 — saved apps ride along as MCP Apps; absent → tools-only door. */
  apps?: AppsPort;
  /** The same resolved host brand the UI pipeline consumes. The prebuilt
   * consent page and MCP Apps shim both emit it as `--vendo-*` variables. */
  theme?: VendoTheme;
  /** 10-mcp §5 — the door's canonical mount path (e.g. `/api/vendo/mcp`). When
   * set, the cold server card advertises THIS transport URL and learned request
   * paths never override it; when unset the card falls back to `/mcp` until an
   * authenticated request teaches it a mount. The umbrella passes its fixed
   * mount so a composed door's card is correct before any traffic arrives. */
  mount?: string;
  /** 10-mcp §5 — the canonical PUBLIC base URL of the deployed host (e.g.
   * `https://app.example.com`). Behind a reverse proxy (Railway, Fly, any TLS
   * terminator) the request URL carries the proxy-INTERNAL origin, so deriving
   * discovery metadata from it advertises unreachable endpoints and binds the
   * RFC 8707 audience to the wrong resource. When set, the issuer, every
   * advertised endpoint, the protected-resource `resource`, the 401 challenge's
   * metadata URL, token audience validation, and the interactive consent URLs
   * (form action, host-login returnTo) all use THIS origin; only the
   * path still comes from the request (or `mount`). Only the URL's origin is
   * used — a path on the base URL is ignored. Forwarded headers (X-Forwarded-*,
   * Host) are attacker-controllable and are never consulted.
   * The umbrella defaults this from `VENDO_BASE_URL`. */
  baseUrl?: string;
  /** Trust access tokens from an external OAuth authorization server instead
   * of serving the door's local authorization-server endpoints. */
  remoteAs?: { issuer: string; jwksUri?: string; audience: string };
  /** Enable the generic signed login-federation handshake at `{mount}/federate`. */
  federation?: { secret: string };
}

export interface McpDoor {
  /** One fetch-style handler serving: MCP Streamable HTTP transport, the OAuth
   * endpoints (§3), and the discovery documents (§5). The umbrella mounts it. */
  handler: (req: Request) => Promise<Response>;
  /** Host-authorized disconnect for one subject/client pair. Revokes every
   * existing local grant family and closes its live MCP sessions. */
  revokeClient: (subject: string, clientId: string) => Promise<void>;
}

export function createMcpDoor(config: McpDoorConfig): McpDoor {
  return createMcpDoorWithState(config, new InMemoryMcpDoorState());
}

/** Package-internal composition hook for transport/state adapters and tests.
 * It is deliberately not re-exported from the package root. */
export function createMcpDoorWithState(config: McpDoorConfig, state: McpDoorState): McpDoor {
  const door = new Door(config, state);
  return {
    handler: (req) => door.handler(req),
    revokeClient: (subject, clientId) => door.revokeClient(subject, clientId),
  };
}

class Door {
  readonly #config: McpDoorConfig;
  readonly #oauth: OAuthServer;
  readonly #remoteAs: RemoteAsVerifier | undefined;
  readonly #state: McpDoorState;
  /** Last mount an MCP request actually arrived at — a server-card hint only.
   * Authority never derives from remembered paths: every flow re-derives its
   * mount from its own request URL, and tokens bind to the canonical resource
   * URI, so a stray probe to an odd path can neither poison discovery nor
   * mint authority for the real mount. */
  #cardMount: string | undefined;
  /** The canonical public origin every advertised URL and audience check uses
   * when `baseUrl` is configured; undefined → derive from each request URL. */
  readonly #publicOrigin: string | undefined;
  #identity: Promise<HostIdentity> | undefined;
  readonly #shimHtml: string;

  constructor(config: McpDoorConfig, state: McpDoorState) {
    this.#config = config;
    this.#state = state;
    this.#oauth = new OAuthServer(config);
    this.#remoteAs = config.remoteAs === undefined ? undefined : new RemoteAsVerifier(config.remoteAs);
    this.#publicOrigin = config.baseUrl === undefined ? undefined : publicOriginOf(config.baseUrl);
    this.#shimHtml = shimHtml(config.theme);
  }

  async handler(req: Request): Promise<Response> {
    // ENG-333: behind a reverse proxy the request URL carries the proxy-
    // internal origin. Rebase the request onto the configured canonical base
    // ONCE, up front, so everything derived from the request URL downstream —
    // discovery metadata, issuer/endpoint URLs, resource identifiers and
    // audience checks, consent form actions, host-login returnTo URLs — speaks
    // the public origin. Only the origin moves; path, query, method, headers,
    // and body are preserved. Unconfigured doors keep request-derived origins,
    // and forwarded headers (X-Forwarded-*, Host) are never consulted either
    // way: the operator-set base is the only trusted origin channel.
    const incoming = new URL(req.url);
    if (this.#publicOrigin !== undefined && incoming.origin !== this.#publicOrigin) {
      req = rebaseRequest(req, this.#publicOrigin, incoming);
    }
    const url = new URL(req.url);
    const origin = url.origin;
    const path = url.pathname;

    if (path.startsWith(PRM_PREFIX)) {
      if (req.method !== "GET") return notFound();
      return json(protectedResourceMetadata(
        origin,
        path.slice(PRM_PREFIX.length),
        this.#config.remoteAs?.issuer,
      ));
    }
    if (path.startsWith(AS_PREFIX)) {
      if (req.method !== "GET" || this.#config.remoteAs !== undefined) return notFound();
      return json(authorizationServerMetadata(origin, path.slice(AS_PREFIX.length)));
    }
    if (path === SERVER_CARD_PATH || path === SERVER_CARD_ALIAS_PATH) {
      if (req.method !== "GET") return notFound();
      // A configured mount is authoritative: a cold composed umbrella advertises
      // the RIGHT transport URL before any traffic, and learned paths never move
      // it. Only an unconfigured door falls back to the learned mount / `/mcp`.
      const mount = this.#config.mount ?? this.#cardMount ?? "/mcp";
      const identity = await this.#hostIdentity();
      // SEP-2127 remains a draft; this deliberately minimal shape tracks it.
      return json({
        name: identity.name,
        version: identity.version,
        description: identity.description,
        protocol_versions: ["2025-11-25"],
        transports: [{ type: "streamable-http", url: resourceUri(origin, mount) }],
        authorization: {
          type: "oauth2",
          resource_metadata: protectedResourceMetadataUrl(origin, mount),
        },
      });
    }

    const endpoint = endpointFor(path);
    const mount = endpoint.mount;
    if (endpoint.kind === "authorize") {
      return this.#config.remoteAs === undefined
        && (req.method === "GET" || (req.method === "POST" && this.#oauth.hasPrebuiltConsent))
        ? this.#oauth.authorize(req, resourceUri(origin, mount))
        : notFound();
    }
    if (endpoint.kind === "token") {
      return req.method === "POST" && this.#config.remoteAs === undefined ? this.#oauth.token(req) : notFound();
    }
    if (endpoint.kind === "revoke") {
      if (req.method !== "POST" || this.#config.remoteAs !== undefined) return notFound();
      const result = await this.#oauth.revoke(req);
      if (result.grant?.tokenType === "refresh_token") {
        if (result.grant.familyId === undefined) {
          await this.#killSubjectClient(result.grant.subject, result.grant.clientId);
        } else {
          await this.#killGrantFamily(result.grant.familyId);
        }
      }
      return result.response;
    }
    if (endpoint.kind === "register") {
      return req.method === "POST" && this.#config.remoteAs === undefined ? this.#oauth.register(req) : notFound();
    }
    if (endpoint.kind === "federate") {
      return req.method === "GET"
        && this.#config.federation !== undefined
        && this.#config.oauth.authorize !== undefined
        ? handleFederation(req, resourceUri(origin, mount), this.#config.federation.secret, this.#config.oauth)
        : notFound();
    }
    if (!["GET", "POST", "DELETE"].includes(req.method)) return notFound();
    return this.#handleMcp(req, mount);
  }

  async #handleMcp(req: Request, mount: string): Promise<Response> {
    // handler() has already rebased req onto the canonical public base.
    const origin = new URL(req.url).origin;
    const resource = resourceUri(origin, mount);
    await this.#sweepIdleSessions();
    const auth = this.#remoteAs === undefined
      ? await this.#oauth.authenticate(req)
      : await this.#remoteAs.authenticate(req);
    if (!auth || (this.#remoteAs === undefined && !sameCanonicalUri(auth.grant.resource, resource))) {
      return unauthorized(origin, mount, req.headers.has("authorization"));
    }

    const requestedSessionId = req.headers.get("mcp-session-id") ?? undefined;
    const requestedState = requestedSessionId === undefined
      ? undefined
      : await this.#state.getSession(requestedSessionId) ?? undefined;
    if (
      requestedSessionId !== undefined
      && (
        !requestedState
        || requestedState.subject !== auth.grant.subject
        || requestedState.context.mcpConsent.clientId !== auth.grant.clientId
      )
    ) {
      return unknownSession();
    }

    const principal = await this.#oauth.principal(auth.grant.subject);
    if (principal === null) {
      await this.#killSubject(auth.grant.subject);
      await this.#oauth.auditRevoke(auth.grant.subject, auth.grant.clientId);
      return unauthorized(origin, mount, true);
    }
    // 10-mcp §2: anonymous/ephemeral principals are never served a session —
    // the door persists grants and audit and must have a durable subject.
    if (principal.ephemeral === true) {
      await this.#killSubject(auth.grant.subject);
      return unauthorized(origin, mount, true);
    }
    // Only authenticated traffic teaches the server card its mount — an
    // unauthenticated probe to an arbitrary path must not steer discovery. A
    // configured mount (10-mcp §5) is fixed and never learned over.
    if (this.#config.mount === undefined) this.#cardMount = normalizeMount(mount);

    // The OAuth consent this authenticated request rode in on — projected onto
    // every RunContext the door mints (10-mcp §3), the evidence actions uses to
    // authenticate host execution via ActAs. The inbound bearer itself is never
    // forwarded; only this clientId/scopes projection travels.
    const consent = { clientId: auth.grant.clientId, scopes: auth.grant.scopes };

    if (requestedSessionId !== undefined) {
      requestedState!.context = mcpContext(principal, requestedSessionId, consent);
      await this.#state.touchSession(requestedSessionId, Date.now() + SESSION_IDLE_MS);
      return requestedState!.handleRequest(req);
    }

    const familyId = "familyId" in auth.grant ? auth.grant.familyId : undefined;
    const state = await this.#newSession(auth.grant.subject, principal, consent, familyId);
    const response = await state.handleRequest(req);
    if (state.sessionId === undefined) await state.close();
    return response;
  }

  async #newSession(
    subject: string,
    principal: Principal,
    consent: { clientId: string; scopes: string[] },
    grantFamilyId?: string,
  ): Promise<SessionState> {
    const identity = await this.#hostIdentity();
    let state: SessionState;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `mcps_${randomHex(16)}`,
      enableJsonResponse: true,
      onsessioninitialized: async (sessionId) => {
        state.sessionId = sessionId;
        state.replayScope = sessionId;
        state.context = mcpContext(state.context.principal, sessionId, consent);
        await this.#state.setSession({
          sessionId,
          subject,
          clientId: consent.clientId,
          ...(grantFamilyId === undefined ? {} : { grantFamilyId }),
          session: state,
          expiresAt: Date.now() + SESSION_IDLE_MS,
        });
      },
      onsessionclosed: async (sessionId) => {
        await this.#state.deleteSession(sessionId);
      },
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
    const initialContextKey = `mcpr_${randomHex(16)}`;
    state = {
      subject,
      replayScope: initialContextKey,
      context: mcpContext(principal, initialContextKey, consent),
      server,
      transport,
      handleRequest: (req) => transport.handleRequest(req),
      close: () => transport.close(),
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
      this.#callTool(request.params.name, request.params.arguments ?? {}, state, identity));

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
          ? [{ uri: SHIM_URI, mimeType: SHIM_MIME_TYPE, text: this.#shimHtml }]
          : [],
      }));
    }
  }

  async #listedTools(): Promise<Tool[]> {
    const descriptors = await this.#config.tools.descriptors();
    const appsConfigured = this.#config.apps !== undefined;
    // The bound registry's descriptors are served VERBATIM — name, description,
    // and inputSchema are the registry's, never the door's (10-mcp §2/§4). But a
    // registry that owns an app-viewer name (e.g. vendo_apps_open from
    // apps.agentTools(), which the umbrella registers) must still advertise the
    // MCP Apps shim so the client preloads the renderer: we attach ONLY the
    // door's `_meta.ui` to those listings (FIX E). Execution still routes through
    // the registry (one guard decision), and #callTool unwraps its OpenSurface
    // output into a shim-renderable payload.
    const tools: Tool[] = descriptors.map(({ name, description, inputSchema }) => {
      const tool: Tool = { name, description, inputSchema: inputSchema as Tool["inputSchema"] };
      if (appsConfigured && APP_TOOL_NAMES.has(name)) tool._meta = appUiMeta();
      return tool;
    });
    // The door's own ride-along tools are additions for the app-viewer names the
    // registry does NOT own (e.g. vendo_apps_list / vendo_apps_call when only
    // vendo_apps_open is registered) — a same-named registry tool keeps its
    // verbatim descriptor (with door `_meta` attached above) and is not duplicated.
    if (appsConfigured) {
      const taken = new Set(tools.map((tool) => tool.name));
      tools.push(...appTools().filter((tool) => !taken.has(tool.name)));
    }
    return tools;
  }

  async #callTool(
    name: string,
    args: Record<string, unknown>,
    state: SessionState,
    identity: HostIdentity,
  ): Promise<CallToolResult> {
    const descriptors = await this.#config.tools.descriptors();
    if (!descriptors.some((descriptor) => descriptor.name === name)) {
      if (this.#config.apps !== undefined && APP_TOOL_NAMES.has(name)) {
        return this.#callAppsTool(name, args, state, identity);
      }
      return inBandError(`not-found: Tool ${name} was not found`);
    }
    const id = await this.#replayId(state, name, args);
    const outcome = await this.#config.tools.execute({ id, tool: name, args }, state.context);
    await this.#recordReplay(state, name, args, id, outcome.status);
    // FIX E: a bound registry that owns an app-viewer name (vendo_apps_open via
    // apps.agentTools()) returns an OpenSurface envelope ({kind,payload}); the
    // MCP Apps shim renders a bare format-tagged UIPayload (core §8), so unwrap
    // it exactly as the door's own apps path does before mapping the result.
    if (name === "vendo_apps_open" && this.#config.apps !== undefined && outcome.status === "ok") {
      const output = await this.#mcpAppsOpenOutput(outcome.output, args, state.context, identity);
      return mapOutcome({ status: "ok", output: output as Json }, identity.name);
    }
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
    state: SessionState,
    identity: HostIdentity,
  ): Promise<CallToolResult> {
    const ctx = state.context;
    const descriptor = APP_TOOL_DESCRIPTORS.find((candidate) => candidate.name === name);
    if (this.#config.apps === undefined || descriptor === undefined) {
      return inBandError(`not-found: Tool ${name} was not found`);
    }
    const id = await this.#replayId(state, name, args);
    const call = { id, tool: name, args: args as Json };
    const decision = await this.#config.guard.check(call, descriptor, ctx);
    const outcome: ToolOutcome = decision.action === "block"
      ? { status: "blocked", reason: decision.reason }
      : decision.action === "ask"
        ? { status: "pending-approval", approvalId: decision.approval.id }
        : await this.#executeAppsTool(name, args, ctx, identity);
    await this.#recordReplay(state, name, args, id, outcome.status);
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

  async #executeAppsTool(
    name: string,
    args: Record<string, unknown>,
    ctx: RunContext,
    identity: HostIdentity,
  ): Promise<ToolOutcome> {
    const apps = this.#config.apps!;
    try {
      if (name === "vendo_apps_list") {
        return { status: "ok", output: await apps.list(ctx) };
      }
      const appId = typeof args.appId === "string" ? args.appId : undefined;
      if (!appId) return { status: "error", error: { code: "validation", message: "appId is required" } };
      if (name === "vendo_apps_open") {
        const opened = await apps.open(appId, ctx);
        return { status: "ok", output: await this.#mcpAppsOpenOutput(opened, args, ctx, identity) as Json };
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

  /** 01-core: ToolCall ids are unique per call. The door mints a fresh id per
   * tools/call, except for an identical still-parked call in the same context.
   * Guard's one-off approval is pinned to that exact id, so retry must reuse it. */
  async #replayId(
    state: McpStateSession,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const existing = await this.#state.getReplay(
      state.replayScope,
      replayKey(tool, args),
      Date.now(),
    );
    return existing ?? `mctc_${crypto.randomUUID()}`;
  }

  async #recordReplay(
    state: McpStateSession,
    tool: string,
    args: Record<string, unknown>,
    id: string,
    status: ToolOutcome["status"],
  ): Promise<void> {
    const scope = state.replayScope;
    const key = replayKey(tool, args);
    if (status === "pending-approval") {
      await this.#state.setReplay(scope, key, id, {
        subject: state.subject,
        expiresAt: Date.now() + SESSION_IDLE_MS,
        capacity: REPLAY_CAP,
      });
    } else {
      // Any resolved outcome spends the one-off approval. A later identical
      // call must mint a fresh id and park anew.
      await this.#state.deleteReplay(scope, key);
    }
  }

  async #mcpAppsOpenOutput(
    output: unknown,
    args: Record<string, unknown>,
    ctx: RunContext,
    identity: HostIdentity,
  ): Promise<unknown> {
    let appName: string | undefined;
    if (isHttpOpenSurface(output) && typeof args.appId === "string") {
      try {
        appName = (await this.#config.apps!.list(ctx)).find((app) => app.id === args.appId)?.name;
      } catch {
        // The app already opened successfully. Naming the card is best-effort;
        // a secondary list failure must not hide the safe link-out path.
      }
    }
    return mcpAppsOpenOutput(output, { productName: identity.name, appName });
  }

  async #sweepIdleSessions(): Promise<void> {
    for (const session of await this.#state.sweepExpiredSessions(Date.now())) {
      try {
        await session.close();
      } catch {
        // A transport already closing is exactly the state we want it in.
      }
    }
  }

  async #killSubject(subject: string): Promise<void> {
    for (const session of await this.#state.deleteSessionsBySubject(subject)) {
      try {
        await session.close();
      } catch {
        // Revocation must remain fail-closed even if a transport is already closing.
      }
    }
  }

  async revokeClient(subject: string, clientId: string): Promise<void> {
    await this.#oauth.revokeClient(subject, clientId);
    await this.#killSubjectClient(subject, clientId);
    await this.#oauth.auditRevoke(subject, clientId);
  }

  async #killSubjectClient(subject: string, clientId: string): Promise<void> {
    await this.#closeSessions(await this.#state.deleteSessionsBySubjectClient(subject, clientId));
  }

  async #killGrantFamily(familyId: string): Promise<void> {
    await this.#closeSessions(await this.#state.deleteSessionsByGrantFamily(familyId));
  }

  async #closeSessions(sessions: McpStateSession[]): Promise<void> {
    for (const session of sessions) {
      try {
        await session.close();
      } catch {
        // Revocation must remain fail-closed even if a transport is already closing.
      }
    }
  }

  #hostIdentity(): Promise<HostIdentity> {
    this.#identity ??= readHostIdentity();
    return this.#identity;
  }
}

function endpointFor(path: string): {
  kind: "mcp" | "authorize" | "token" | "revoke" | "register" | "federate";
  mount: string;
} {
  for (const [suffix, kind] of [
    ["/authorize", "authorize"],
    ["/token", "token"],
    ["/revoke", "revoke"],
    ["/register", "register"],
    ["/federate", "federate"],
  ] as const) {
    if (path.endsWith(suffix)) return { kind, mount: path.slice(0, -suffix.length) };
  }
  return { kind: "mcp", mount: path };
}

function normalizeMount(mount: string): string {
  if (!mount || mount === "/") return "";
  return `/${mount.replace(/^\/+|\/+$/g, "")}`;
}

/** Reduce the configured base URL to its canonical origin, failing LOUD at
 * construction — a malformed base silently falling back to request-derived
 * origins would ship wrong discovery documents to every client. */
function publicOriginOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl must be an absolute http(s) URL, got ${JSON.stringify(baseUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`baseUrl must be an absolute http(s) URL, got ${JSON.stringify(baseUrl)}`);
  }
  if (url.username || url.password) {
    throw new TypeError("baseUrl cannot contain credentials");
  }
  return url.origin;
}

/** Move a request onto the canonical public origin, preserving everything
 * else. The shape production hosts proved as a workaround (runvendo/umami#1),
 * now owned by the door itself. */
function rebaseRequest(req: Request, origin: string, incoming: URL): Request {
  const url = new URL(`${incoming.pathname}${incoming.search}`, origin);
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
    ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req.body, duplex: "half" }),
  };
  return new Request(url, init);
}

function resourceUri(origin: string, mount: string): string {
  return canonicalUri(`${origin}${normalizeMount(mount)}`);
}

function protectedResourceMetadataUrl(origin: string, mount: string): string {
  return canonicalUri(origin) + PRM_PREFIX + normalizeMount(mount);
}

function protectedResourceMetadata(origin: string, mount: string, remoteIssuer?: string) {
  const resource = resourceUri(origin, mount);
  return {
    resource,
    authorization_servers: [remoteIssuer ?? resource],
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata(origin: string, mount: string) {
  const issuer = resourceUri(origin, mount);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    revocation_endpoint: `${issuer}/revoke`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: ["read", "write"],
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

/** 10-mcp §4 — the MCP Apps `_meta` that advertises the shim resource so a host
 * client preloads the tree renderer. A non-renderable result (e.g. a list) is
 * contained gracefully by the shim's core-§8 format dispatch. */
function appUiMeta(): { ui: { resourceUri: string }; "ui/resourceUri": string } {
  return { ui: { resourceUri: SHIM_URI }, "ui/resourceUri": SHIM_URI };
}

function appTools(): Tool[] {
  // 10-mcp §4 names both vendo_apps_list and vendo_apps_open as carrying
  // _meta.ui.resourceUri; all three ride-along tools advertise the shim so the
  // host can preload it.
  return APP_TOOL_DESCRIPTORS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema: inputSchema as Tool["inputSchema"],
    _meta: appUiMeta(),
  }));
}

/** FIX E — the registry's vendo_apps_open returns an OpenSurface envelope
 * (`{ kind: "tree", payload } | { kind: "http", url } | { kind: "resuming" }`);
 * the door's own apps path projects that same envelope. Unwrap tree surfaces so
 * a registry-executed open renders identically over MCP Apps. HTTP surfaces are
 * retained for the explicitly-tagged link-out projection below. A
 * `resuming` (or any other shape) passes through untouched — the shim's core-§8
 * dispatch contains an unrenderable payload gracefully. */
function unwrapAppsOpen(output: unknown): unknown {
  if (isRecord(output) && typeof output.kind === "string") {
    if (output.kind === "tree") return output.payload;
  }
  return output;
}

function isHttpOpenSurface(output: unknown): output is { kind: "http"; url: string } {
  return isRecord(output) && output.kind === "http" && typeof output.url === "string";
}

interface OpenInProductPayload {
  kind: typeof OPEN_IN_PRODUCT_KIND;
  url: string;
  productName: string;
  appName?: string;
}

/** AppsRuntime.open has already resolved every v0 tree query into `tree.data`
 * (06-apps §1). The query declarations remain on the in-product payload so a
 * later open/refresh can resolve them again, but forwarding them to the MCP
 * shim would execute every query a second time. Project the already-resolved
 * payload immutably and keep the shim resolver only as a compatibility fallback
 * for non-door hosts that send unresolved trees directly. */
function mcpAppsOpenOutput(
  output: unknown,
  details: { productName: string; appName?: string },
): unknown {
  if (isHttpOpenSurface(output)) {
    const projected: OpenInProductPayload = {
      kind: OPEN_IN_PRODUCT_KIND,
      url: output.url,
      productName: details.productName,
      ...(details.appName === undefined ? {} : { appName: details.appName }),
    };
    return projected;
  }
  const payload = unwrapAppsOpen(output);
  if (!isRecord(payload) || payload.formatVersion !== "vendo-genui/v1" || !Object.hasOwn(payload, "queries")) {
    return payload;
  }
  const projected = { ...payload };
  delete projected.queries;
  return projected;
}
function replayKey(tool: string, args: Record<string, unknown>): string {
  return `${tool} ${canonicalJson(args)}`;
}

/** Stable JSON with lexicographically-sorted object keys, so two structurally
 * identical arg objects fingerprint the same regardless of key insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
  const text = isOpenInProductPayload(output)
    ? `Open ${output.appName ?? "this app"} in ${output.productName}: ${output.url}`
    : stringify(output);
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (isRecord(output)) result.structuredContent = output;
  return result;
}

function inBandError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenInProductPayload(value: unknown): value is OpenInProductPayload {
  return isRecord(value)
    && value.kind === OPEN_IN_PRODUCT_KIND
    && typeof value.url === "string"
    && typeof value.productName === "string"
    && (value.appName === undefined || typeof value.appName === "string");
}

function stringify(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function mcpContext(
  principal: Principal,
  sessionId: string,
  consent: { clientId: string; scopes: string[] },
): McpRunContext {
  return { principal, venue: "mcp", presence: "present", sessionId, mcpConsent: consent };
}

/** Keep the shipped shim byte-for-byte generic. A door instance specializes
 * only the resource it serves, at construction time, through one inert marker
 * in the generated HTML. Known property names plus escaped values prevent host
 * theme strings from breaking out of the declaration or style element. */
function shimHtml(theme: VendoTheme | undefined): string {
  const style = theme === undefined
    ? ""
    : `<style data-vendo-mcp-theme>:root{${themeDeclarations(theme)}}</style>`;
  return SHIM_HTML.replace(SHIM_THEME_MARKER, style);
}

function themeDeclarations(theme: VendoTheme): string {
  const declarations: Array<[string, string | undefined]> = [
    ["--vendo-color-background", theme.colors.background],
    ["--vendo-color-surface", theme.colors.surface],
    ["--vendo-color-text", theme.colors.text],
    ["--vendo-color-muted", theme.colors.muted],
    ["--vendo-color-accent", theme.colors.accent],
    ["--vendo-color-accent-text", theme.colors.accentText],
    ["--vendo-color-danger", theme.colors.danger],
    ["--vendo-color-border", theme.colors.border],
    ["--vendo-font-family", theme.typography.fontFamily],
    ["--vendo-heading-family", theme.typography.headingFamily],
    ["--vendo-font-size", theme.typography.baseSize],
    ["--vendo-radius-small", theme.radius.small],
    ["--vendo-radius-medium", theme.radius.medium],
    ["--vendo-radius-large", theme.radius.large],
    ["--vendo-density", theme.density],
    ["--vendo-motion", theme.motion],
  ];
  return declarations
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}:${escapeCssValue(value)};`)
    .join("");
}

function escapeCssValue(value: string): string {
  return value.replace(/[\0-\x1f\x7f\\;{}<>]/g, (character) =>
    `\\${character.codePointAt(0)!.toString(16)} `);
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
