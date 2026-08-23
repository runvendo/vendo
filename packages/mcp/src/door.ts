import {
  auditContext,
  type Guard,
  type Json,
  log,
  type Membership,
  type Principal,
  publicBase,
  type RiskLabel,
  type RunContext,
  type StoreAdapter,
  type StoreOps,
  stripPathPrefix,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type ToolResult,
  vendoApprovalRef,
  withPathPrefix,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";
import type {
  VendoTheme,
} from "@vendoai/apps/contract";
import {
  themeCssVariables,
} from "@vendoai/apps/contract";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ProgressToken,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { connectPage } from "./connect-page.js";
import type { HostOAuthAdapter } from "./oauth/adapter.js";
import { handleFederation } from "./oauth/federation.js";
import { RemoteAsVerifier } from "./oauth/remote-as.js";
import { canonicalUri, json, OAuthServer, randomHex, sameCanonicalUri, TOKEN_EXCHANGE_GRANT_TYPE } from "./oauth/server.js";
import { SHIM_HTML } from "./shim/shim-html.gen.js";
import {
  InMemoryMcpDoorState,
  type McpDoorState,
  type McpRunContext,
  type McpStateSession,
} from "./state.js";
import type { LiveTurn, TurnCredentialPort } from "./turn-credential.js";

export type { McpRunContext } from "./state.js";
export type { LiveTurn, TurnCredentialPort } from "./turn-credential.js";

const PRM_PREFIX = "/.well-known/oauth-protected-resource";
const AS_PREFIX = "/.well-known/oauth-authorization-server";
const SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";
const SERVER_CARD_ALIAS_PATH = "/.well-known/mcp-server-card";
const SHIM_URI = "ui://vendo/tree-shim.html";
const SHIM_MIME_TYPE = "text/html;profile=mcp-app";
const OPEN_IN_PRODUCT_KIND = "vendo/open-in-product@1";
const SHIM_THEME_MARKER = "<!--VENDO_MCP_THEME-->";
/** A stock MCP client abandons a tools/call after 60s, and a
 *  notifications/progress extends that deadline only for a client that opted in
 *  with `resetTimeoutOnProgress` — it defaults to false, so frames arrive and
 *  the call still dies on time. The door beats regardless, because beating is
 *  the only half it owns and vendo_make routinely runs longer. */
const PROGRESS_HEARTBEAT_MS = 15_000;

interface HostIdentity {
  name: string;
  version: string;
  description: string;
}

interface SessionState extends McpStateSession {
  server: Server;
  sessionId?: string;
  /**
   * Set only on a TURN-credential session (10-mcp §3b). Its presence is what
   * switches every handler from "the door decides" to "hand it to the turn":
   * the tool surface, the context, the approval behavior and the audit row all
   * come from `turn.tools`, which is the in-process path itself.
   *
   * Re-read from the credential on EVERY request, never captured at open: one
   * conversation's box holds one session across many turns, and presence, venue
   * and the equipped tool set are the CURRENT turn's, not the opening turn's.
   */
  turn?: LiveTurn;
  /** The credential this session was opened with. A session belongs to exactly
   *  the token that created it — the turn-path analogue of the OAuth path's
   *  subject + clientId binding. */
  turnToken?: string;
}

/** The `clientId` a turn session records in door state. Not a secret and not an
 *  OAuth client: the credential itself is never written anywhere durable. */
const HARNESS_CLIENT_ID = "vendo-harness-turn";

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
  /** §3 — the host owns session/principal lookup; the door can own consent too.
   *  Required for an outside-serving door; an `internal` door has no OAuth space
   *  to run, so it needs none and is given none. */
  oauth?: HostOAuthAdapter;
  /** Door-owned protocol state (clients, codes, refresh grants) — wired like every other block. */
  store: StoreAdapter;
  /** The 42-op surface over that SAME store, when the composition could resolve
   *  one. The OAuth space reaches its two drawers through `ops.engine.*` so the
   *  engine allowlist gates every one of them; unset, it serves the same verbs
   *  off the adapter itself (`engineOverAdapter`), which is what a host's BYO
   *  `StoreAdapter` gets. An `internal` door has no OAuth space and reads no
   *  drawer, so it needs none. */
  ops?: StoreOps;
  /** §4 — saved apps ride along as MCP Apps; absent → tools-only door. The
   *  three verbs come off the real runtime (10-mcp §4); the umbrella passes
   *  `vendo.apps` essentially verbatim, narrowing only what `open` may
   *  answer. */
  apps?: Pick<AppsRuntime, "list" | "open" | "call">;
  /** Build contract §9.1 — the host's org query, keyed on `Principal` (never on
   * a Request), resolved once per authenticated request and ridden onto every
   * RunContext this door mints.
   *
   * Load-bearing, not decorative: `can()` reads the caller's orgs from the ctx
   * and never queries them (§9.3), so a door without this seam can never match
   * an `org:`/`team:` grant — a team app shared with the caller would be absent
   * from `list` and not-found on `open`, over this door only. Absent seam ⇒ no
   * orgs asserted ⇒ `can()` degenerates to ownership, which is every unkeyed
   * deployment. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
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
   * `https://app.example.com`, or `https://app.example.com/maple` for a
   * deployment mounted under a path prefix). Behind a reverse proxy (Railway,
   * Fly, any TLS terminator) the request URL carries the proxy-INTERNAL
   * origin — and a prefix the proxy strips — so deriving discovery metadata
   * from it advertises unreachable endpoints and binds the RFC 8707 audience
   * to the wrong resource. When set, the issuer, every advertised endpoint,
   * the protected-resource `resource`, the 401 challenge's metadata URL, token
   * audience validation, and the interactive consent URLs (form action,
   * host-login returnTo) all live under THIS base — origin AND path; only the
   * door-local path still comes from the request (or `mount`). A path on the
   * base URL names the prefix the deployment is mounted under, normalized
   * exactly like `mount`. Forwarded headers (X-Forwarded-*, Host) are
   * attacker-controllable and are never consulted.
   * The umbrella defaults this from `VENDO_BASE_URL`. */
  baseUrl?: string;
  /** Trust access tokens from an external OAuth authorization server instead
   * of serving the door's local authorization-server endpoints. */
  remoteAs?: { issuer: string; jwksUri?: string; audience: string };
  /** Enable the generic signed login-federation handshake at `{mount}/federate`. */
  federation?: { secret: string };
  /** First-party service auth: the host's own backend exchanges one of these
   * opaque keys plus a user id for a short-lived user-bound access token at
   * `{mount}/token`, then talks MCP with it like any other client. Rotation is
   * listing both the old and the new key until the old one is out of use.
   * Unset means the grant is neither advertised nor served. */
  serviceAuth?: { keys: readonly string[] };
  /**
   * The tool menu this door offers — the host's curated `surfaces.mcp` list,
   * resolved by the umbrella (`registry.surfaceMenu("mcp")`) and passed in.
   * Absent = offer the whole bound surface. The door never reads `.vendo`
   * files itself: block layering forbids mcp importing actions, so the
   * composition seam owns the file and the door owns the wire.
   *
   * CURATION, NOT SECURITY. A name outside the menu is neither listed nor
   * callable, but the refusal is the SAME in-band not-found an unknown tool
   * gets — the menu leaks nothing and grants nothing. Vendo's own `vendo_*`
   * tools (the apps ride-alongs and any runtime tool the registry owns) are
   * never curated away: they are the product's plumbing, not the host's API.
   *
   * The provider form exists because composition is synchronous while resolving
   * the menu is not (it reads the authored file through the registry).
   *
   * The door calls it FRESH for every listing and every call, and deliberately
   * does not memoize — not even the resolved value, and never a rejection. The
   * bound registry grows at runtime (an `add()`), so a menu frozen at the
   * first request would leave every
   * late-arriving tool invisible AND uncallable until the process restarted;
   * caching a failed read would freeze the door just as permanently. The
   * registry memoizes its own load underneath, so re-asking costs a map lookup.
   * Providers passed here must therefore be cheap and side-effect free.
   *
   * Resolving to `undefined` means unrestricted.
   */
  menuTools?: string[] | (() => string[] | undefined | Promise<string[] | undefined>);
  /**
   * Names this door NEVER offers, whatever else says otherwise.
   *
   * The MENU curates the host's API and deliberately cannot touch Vendo's own
   * `vendo_*` plumbing. This is the other decision: what THIS door, as deployed,
   * does not do. It is checked BEFORE the prefix bypass, so a deployment can
   * hold back a runtime tool (the placement pair, for a door whose client has no
   * page to place anything on) without inventing a second menu.
   *
   * Same posture as the menu: curation, not security. A withheld name is neither
   * listed nor callable, and the refusal is the SAME in-band not-found an
   * unknown name gets — it leaks nothing and grants nothing. The guard, not this
   * list, is what stops a call that IS offered.
   *
   * A plain list rather than a provider: unlike the menu (which is read from a
   * file that changes under a running process), this is authored in composition
   * and cannot change without one.
   */
  withholdTools?: string[];
  /**
   * The product name shown to PEOPLE (the connect page) and advertised on the
   * server card. Wins over the `package.json` name the door otherwise reads,
   * which is a package id and is often not what the product is called. Set it
   * when the two differ.
   */
  productName?: string;
  /**
   * 10-mcp §3b — the host process's own turn-scoped credential seam.
   *
   * The door was built for OUTSIDE agents, and an outside agent has no turn: no
   * venue but `mcp`, no presence but `present`, no stream to put an approval
   * card on. A `claudeCode()` box reaching its host's tools over native remote
   * MCP has all three, and losing them at the door made the door unusable for it
   * (measured — `packages/vendo/src/mcp-door-parity.e2e.test.ts`).
   *
   * A bearer this port resolves is answered from the LIVE TURN it names: the
   * turn's own ctx, the turn's own equipped tools, and `turn.tools.call()` for
   * execution — which means one guard decision, one audit row, one transcript
   * mirror, the turn's own approval card, and `workspace.commit()`, none of them
   * reimplemented here.
   *
   * Unset (every deployment that never composed a harness): there is no second
   * credential space and the door behaves exactly as it did before.
   */
  turnCredentials?: TurnCredentialPort;
  /**
   * Serve the turn-credential space and NOTHING else.
   *
   * A composition that names a harness thinking outside this process needs a
   * door for that harness alone. `mcp: true` means one thing and must keep
   * meaning it — "my users may connect third-party agents to my product" — so
   * the two decisions are decoupled here rather than in the host's config: an
   * internal door has no authorization server, no discovery documents, no
   * consent page, no client registration, no outside session, and no listing
   * for anyone but a live turn. Its mount answers a valid turn bearer, and
   * answers everything else with a 401 that names no way in.
   *
   * `oauth` is meaningless here and is not read.
   */
  internal?: boolean;
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
  /** {@link McpDoorConfig.withholdTools}, resolved once — config is fixed at
   *  construction, so unlike the menu there is nothing to re-read. */
  readonly #withheld: ReadonlySet<string>;
  /** The OUTSIDE credential space, as this door holds it: the protocol server
   *  and the host's own adapter, present or absent TOGETHER. Both are undefined
   *  on an `internal` door — which is the whole of what "internal" means, and
   *  the reason the flag cannot be contradicted by anything else in the config. */
  readonly #oauth: OAuthServer | undefined;
  readonly #hostOAuth: HostOAuthAdapter | undefined;
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
  /** The path prefix the deployment is mounted under — the configured base
   * URL's path, normalized exactly like `mount` (`""` when there is none).
   * Advertised URLs carry it; door-local routing strips it. */
  readonly #publicBasePath: string;
  #identity: Promise<HostIdentity> | undefined;
  readonly #shimHtml: string;

  constructor(config: McpDoorConfig, state: McpDoorState) {
    this.#config = config;
    this.#state = state;
    this.#withheld = new Set(config.withholdTools ?? []);
    // `internal` WINS, and it wins here rather than at each route, so there is
    // exactly one place that can decide whether an outside space exists. An
    // adapter passed alongside it is dropped rather than rejected: the flag is
    // an explicit opt-in nobody types by accident, dropping fails CLOSED (the
    // caller gets the locked door they named), and throwing would turn a safe
    // misconfiguration — one config bag reused for both door shapes — into a
    // boot crash.
    const outside = config.internal === true ? undefined : config.oauth;
    if (config.internal !== true && outside === undefined) {
      throw new TypeError(
        "an outside-serving MCP door requires a HostOAuthAdapter (10-mcp §3); "
        + "pass `internal: true` for a door that serves only live turns",
      );
    }
    this.#hostOAuth = outside;
    this.#oauth = outside === undefined
      ? undefined
      : new OAuthServer({ ...config, oauth: outside });
    this.#remoteAs = config.remoteAs === undefined ? undefined : new RemoteAsVerifier(config.remoteAs);
    const base = config.baseUrl === undefined ? undefined : publicBase(config.baseUrl);
    this.#publicOrigin = base?.origin;
    this.#publicBasePath = base?.path ?? "";
    this.#shimHtml = shimHtml(config.theme);
  }

  async handler(req: Request): Promise<Response> {
    // ENG-333: behind a reverse proxy the request URL carries the proxy-
    // internal origin — and when the deployment is mounted under a path
    // prefix the proxy strips, a prefix-less path. Rebase the request onto
    // the configured canonical base ONCE, up front, so everything derived
    // from the request URL downstream — discovery metadata, issuer/endpoint
    // URLs, resource identifiers and audience checks, consent form actions,
    // host-login returnTo URLs — speaks the public origin AND the public
    // prefix. Query, method, headers, and body are preserved. Unconfigured
    // doors keep request-derived origins, and forwarded headers
    // (X-Forwarded-*, Host) are never consulted either way: the operator-set
    // base is the only trusted channel.
    const incoming = new URL(req.url);
    if (this.#publicOrigin !== undefined) {
      const publicPath = withPathPrefix(this.#publicBasePath, incoming.pathname);
      if (incoming.origin !== this.#publicOrigin || publicPath !== incoming.pathname) {
        req = rebaseRequest(req, this.#publicOrigin, publicPath, incoming);
      }
    }
    const url = new URL(req.url);
    // Every advertised URL builds from the full public base; routing below
    // uses the DOOR-LOCAL path, with the public prefix stripped back off.
    const base = url.origin + this.#publicBasePath;
    const path = stripPathPrefix(this.#publicBasePath, url.pathname);

    // 10-mcp §3b — an INTERNAL door has no outside credential space, so none of
    // the routes below (which exist only to get an outsider one) are served.
    // Read off the door's OWN fields, never `config.oauth`: an internal door may
    // have been handed an adapter, and the config is not the authority.
    const oauth = this.#oauth;
    const hostOAuth = this.#hostOAuth;
    if (oauth === undefined || hostOAuth === undefined) return this.#internalOnly(req, path);

    // A well-known suffix is a mount, and it arrives in BOTH public spellings:
    // prefix-including from a spec client's root-insertion (RFC 8414/9728
    // derive the well-known URL from the FULL resource URI), prefix-less from
    // the door's own prefix-local metadata URL. Strip the prefix so both name
    // the same door-local mount — `base` puts it back exactly once.
    if (path.startsWith(PRM_PREFIX)) {
      if (req.method !== "GET") return notFound();
      return json(protectedResourceMetadata(
        base,
        stripPathPrefix(this.#publicBasePath, path.slice(PRM_PREFIX.length)),
        this.#config.remoteAs?.issuer,
      ));
    }
    if (path.startsWith(AS_PREFIX)) {
      if (req.method !== "GET" || this.#config.remoteAs !== undefined) return notFound();
      return json(authorizationServerMetadata(
        base,
        stripPathPrefix(this.#publicBasePath, path.slice(AS_PREFIX.length)),
        this.#config.serviceAuth !== undefined,
      ));
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
        name: this.#config.productName ?? identity.name,
        version: identity.version,
        description: identity.description,
        protocol_versions: ["2025-11-25"],
        transports: [{ type: "streamable-http", url: resourceUri(base, mount) }],
        authorization: {
          type: "oauth2",
          resource_metadata: protectedResourceMetadataUrl(base, mount),
        },
      });
    }

    const endpoint = endpointFor(path);
    const mount = endpoint.mount;
    if (endpoint.kind === "authorize") {
      return this.#config.remoteAs === undefined
        && (req.method === "GET" || (req.method === "POST" && oauth.hasPrebuiltConsent))
        ? oauth.authorize(req, resourceUri(base, mount))
        : notFound();
    }
    if (endpoint.kind === "token") {
      return req.method === "POST" && this.#config.remoteAs === undefined
        ? oauth.token(req, resourceUri(base, mount))
        : notFound();
    }
    if (endpoint.kind === "revoke") {
      if (req.method !== "POST" || this.#config.remoteAs !== undefined) return notFound();
      const result = await oauth.revoke(req);
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
      return req.method === "POST" && this.#config.remoteAs === undefined ? oauth.register(req) : notFound();
    }
    if (endpoint.kind === "federate") {
      return req.method === "GET"
        && this.#config.federation !== undefined
        && (hostOAuth.authorize !== undefined || hostOAuth.session !== undefined)
        ? handleFederation(req, resourceUri(base, mount), this.#config.federation.secret, hostOAuth)
        : notFound();
    }
    if (endpoint.kind === "connect") {
      // The one door page for PEOPLE: no session, no token, nothing a client
      // could not already read off the public server card.
      if (req.method !== "GET") return notFound();
      const identity = await this.#hostIdentity();
      return connectPage({
        productName: this.#config.productName ?? identity.name,
        mcpUrl: resourceUri(base, this.#config.mount ?? mount),
        ...(this.#config.theme === undefined ? {} : { theme: this.#config.theme }),
      });
    }
    if (!["GET", "POST", "DELETE"].includes(req.method)) return notFound();
    return this.#handleMcp(req, mount, oauth);
  }

  /**
   * The whole of an INTERNAL door: one credential space, and no way into the
   * other because the other is not there.
   *
   * Nothing is disabled here — the outside half is simply never constructed, so
   * discovery, the authorization server, consent, registration and the connect
   * page are all just absent paths. The mount answers a live turn's bearer
   * exactly as a full door does (the same `#handleTurnMcp`, unchanged), and
   * answers everything else with a 401 that carries NO `www-authenticate`: a
   * challenge names a resource-metadata URL, and naming one would be pointing
   * at a sign-in path that does not exist.
   */
  async #internalOnly(req: Request, path: string): Promise<Response> {
    if (outsideSpacePath(path)) return notFound();
    if (!["GET", "POST", "DELETE"].includes(req.method)) return notFound();
    await this.#sweepIdleSessions();
    const presented = bearerOf(req);
    const turn = presented === undefined ? null : await this.#resolveTurn(presented);
    if (turn === null) return locked();
    return this.#handleTurnMcp(req, path, presented!, turn);
  }

  async #handleMcp(req: Request, mount: string, oauth: OAuthServer): Promise<Response> {
    // handler() has already rebased req onto the canonical public base.
    const base = new URL(req.url).origin + this.#publicBasePath;
    const resource = resourceUri(base, mount);
    await this.#sweepIdleSessions();

    // 10-mcp §3b, FIRST and separate: a turn credential is the host's own
    // process talking to itself, not an OAuth grant. It is a different
    // credential SPACE — resolved by the umbrella's registry, never by the
    // door's grant store — so nothing about the outside-agent path below can be
    // reached with one, and nothing here can be reached with a grant.
    const presented = bearerOf(req);
    const turn = presented === undefined ? null : await this.#resolveTurn(presented);
    if (turn !== null) return this.#handleTurnMcp(req, mount, presented!, turn);

    const auth = this.#remoteAs === undefined
      ? await oauth.authenticate(req)
      : await this.#remoteAs.authenticate(req);
    if (!auth || (this.#remoteAs === undefined && !sameCanonicalUri(auth.grant.resource, resource))) {
      return unauthorized(base, mount, req.headers.has("authorization"));
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
        // A TURN session is never reachable with an OAuth grant: it carries no
        // consent projection, so this comparison can only ever fail for one.
        || requestedState.context.mcpConsent?.clientId !== auth.grant.clientId
      )
    ) {
      return unknownSession();
    }

    const principal = await oauth.principal(auth.grant.subject);
    if (principal === null) {
      await this.#killSubject(auth.grant.subject);
      await oauth.auditRevoke(auth.grant.subject, auth.grant.clientId);
      return unauthorized(base, mount, true);
    }
    // 10-mcp §2: anonymous/ephemeral principals are never served a session —
    // the door persists grants and audit and must have a durable subject.
    if (principal.ephemeral === true) {
      await this.#killSubject(auth.grant.subject);
      return unauthorized(base, mount, true);
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
    // §9.1 — resolved ONCE per authenticated request, beside the consent
    // projection and for the same reason: both are per-request facts about the
    // caller that every ctx this request mints has to carry.
    const memberships = await this.#config.memberships?.(principal);

    if (requestedSessionId !== undefined) {
      requestedState!.context = mcpContext(principal, requestedSessionId, consent, memberships);
      await this.#state.touchSession(requestedSessionId, Date.now() + SESSION_IDLE_MS);
      return requestedState!.handleRequest(req);
    }

    const familyId = "familyId" in auth.grant ? auth.grant.familyId : undefined;
    const state = await this.#newSession(auth.grant.subject, principal, consent, memberships, familyId);
    const response = await state.handleRequest(req);
    if (state.sessionId === undefined) await state.close();
    return response;
  }

  /** Never throws and never distinguishes "no port" from "no such token": both
   *  mean this bearer is not a turn credential, and the OAuth path answers. */
  async #resolveTurn(token: string): Promise<LiveTurn | null> {
    if (this.#config.turnCredentials === undefined) return null;
    try {
      return await this.#config.turnCredentials.resolve(token);
    } catch (error) {
      log({
        code: "mcp.turn-credential-lookup-failed",
        level: "error",
        message: "[vendo] mcp door: turn credential lookup failed",
        data: {
          detail: { error: error instanceof Error ? error.message : String(error) },
        },
      });
      return null;
    }
  }

  /**
   * The turn-bearing leg. Everything the door normally decides is deferred to
   * the live turn, so this function's whole job is session bookkeeping.
   *
   * The credential is re-resolved per request (by the caller) and re-attached
   * here, because one box holds ONE session across MANY turns: a session that
   * captured its opening turn would report turn 1's presence and turn 1's
   * equipped tools forever.
   */
  async #handleTurnMcp(req: Request, mount: string, token: string, turn: LiveTurn): Promise<Response> {
    if (this.#config.mount === undefined) this.#cardMount = normalizeMount(mount);
    const requestedSessionId = req.headers.get("mcp-session-id") ?? undefined;
    const requested = requestedSessionId === undefined
      ? undefined
      : (await this.#state.getSession(requestedSessionId) ?? undefined) as SessionState | undefined;
    if (requestedSessionId !== undefined && requested?.turnToken !== token) {
      // Wrong credential for this session — including an OAuth client that
      // learned a session id, and a credential for a different conversation.
      return unknownSession();
    }
    if (requested !== undefined) {
      requested.turn = turn;
      requested.context = turn.ctx;
      await this.#state.touchSession(requestedSessionId!, Date.now() + SESSION_IDLE_MS);
      return requested.handleRequest(req);
    }
    const state = await this.#newSession(
      turn.ctx.principal.subject,
      turn.ctx.principal,
      { clientId: HARNESS_CLIENT_ID, scopes: [] },
      undefined,
      undefined,
      { token, turn },
    );
    const response = await state.handleRequest(req);
    if (state.sessionId === undefined) await state.close();
    return response;
  }

  async #newSession(
    subject: string,
    principal: Principal,
    consent: { clientId: string; scopes: string[] },
    memberships: Membership[] | undefined,
    grantFamilyId?: string,
    /** Set for a turn-credential session: its context is the TURN's, verbatim,
     *  so nothing here relabels the venue or invents a consent projection. */
    bearing?: { token: string; turn: LiveTurn },
  ): Promise<SessionState> {
    const identity = await this.#hostIdentity();
    let state: SessionState;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `mcps_${randomHex(16)}`,
      enableJsonResponse: true,
      onsessioninitialized: async (sessionId) => {
        state.sessionId = sessionId;
        state.replayScope = sessionId;
        if (bearing === undefined) {
          state.context = mcpContext(state.context.principal, sessionId, consent, memberships);
        }
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
    // No `listChanged`: the door's listing is fixed for the life of a session.
    // Nothing materializes tools mid-session any more (the service-tool pair is
    // permanent), and an SDK client lists once and caches — a promise nobody
    // keeps is worse than none.
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
    // The reader for the standalone SSE body this session is serving. The DOOR
    // holds it, and only the door ever cancels it, because cancelling it is the
    // one thing that releases the transport's `_GET_stream` registration — see
    // `releaseStandalone`.
    let standalone: ReadableStreamDefaultReader<Uint8Array> | undefined;
    /** Give the transport back its standalone slot, and wait until it is gone. */
    const releaseStandalone = async (): Promise<void> => {
      const held = standalone;
      if (held === undefined) return;
      standalone = undefined;
      // Awaited: the transport deletes the registration inside the body's own
      // `cancel` callback, so this has to finish BEFORE anything registers a
      // replacement. `closeStandaloneSSEStream` is not enough and not used —
      // it closes the controller with frames still queued, which leaves the
      // stream readable, so the release fires whenever the abandoned body is
      // eventually discarded and deletes whatever is registered THEN.
      await held.cancel().catch(() => {});
    };
    /** Hand the client a body the DOOR owns, so the transport's registration is
     *  reached only by whoever still HOLDS the slot — this body's own cancel, or
     *  `releaseStandalone` — and never by a body a reconnect replaced. */
    const adoptStandalone = (response: Response): Response => {
      if (response.body === null) return response;
      const reader = response.body.getReader();
      standalone = reader;
      const relayed = new ReadableStream<Uint8Array>({
        // EOF and read errors pass straight through and leave the slot alone.
        // The transport DOES end this stream on a slot the door still holds: the
        // client's own DELETE routes into `handleDeleteRequest`, which closes the
        // transport and with it the controller. Harmless, because `onsessionclosed`
        // drops the session from `#state` first, so the closure holding this stale
        // reader is unreachable and that session id answers `unknownSession()`.
        // Every other end is genuinely unreachable: the transport never calls
        // `controller.error` (`writeSSEEvent` swallows a throwing enqueue), there
        // is no timeout, abort or backpressure close, `closeStandaloneSSEStream`
        // is only wired when an event store is configured (the door configures
        // none), and POST stream ids are random UUIDs so `closeSSEStream` can
        // never resolve to the standalone slot.
        async pull(controller) {
          const frame = await reader.read();
          if (frame.done) controller.close();
          else controller.enqueue(frame.value);
        },
        // The client hung up — a LIVE one, so the transport's registration and
        // this reader are dead weight until something clears them, and the idle
        // sweep only runs on another request, never on a timer. Cancelling is what
        // releases the registration.
        //
        // Guarded on still HOLDING the slot, and it is the SLOT this protects, not
        // the cancel: a dead body is discarded whenever the runtime gets round to
        // it, so this can fire after a reconnect moved the slot on, and clearing it
        // there would drop the door's only handle on the stream it is now serving —
        // leaving `releaseStandalone` unable to free the next 409.
        cancel() {
          if (standalone !== reader) return;
          standalone = undefined;
          void reader.cancel();
        },
      });
      return new Response(relayed, { status: response.status, headers: response.headers });
    };
    state = {
      subject,
      replayScope: initialContextKey,
      context: bearing === undefined
        ? mcpContext(principal, initialContextKey, consent, memberships)
        : bearing.turn.ctx,
      ...(bearing === undefined ? {} : { turn: bearing.turn, turnToken: bearing.token }),
      server,
      handleRequest: async (req) => {
        if (req.method !== "GET") return transport.handleRequest(req);
        let response = await transport.handleRequest(req);
        // 409 is the transport guarding a standalone registration, and it is the
        // LAST gate it applies: a wrong `Accept` (406), a bad protocol version and
        // DNS-rebinding validation all answer before it. So a 409 — and ONLY a
        // 409 — means this GET is a healthy client asking to be reachable and the
        // sole obstacle is a registration nobody is reading. Releasing before
        // every GET instead destroys a healthy stream whenever the transport goes
        // on to reject the request, which is why this waits for the 409.
        if (response.status === 409) {
          await releaseStandalone();
          response = await transport.handleRequest(req);
        }
        if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
        return adoptStandalone(response);
      },
      close: async () => {
        await releaseStandalone();
        await transport.close();
      },
    };
    this.#registerHandlers(state, identity);
    await server.connect(transport);
    return state;
  }

  #registerHandlers(state: SessionState, identity: HostIdentity): void {
    state.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = state.turn === undefined
        ? await this.#listedTools(state)
        : await turnTools(state.turn, this.#withheld, this.#config.apps !== undefined);
      return { tools };
    });
    state.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      withProgress(state.server, request.params._meta?.progressToken, () =>
        this.#callTool(request.params.name, request.params.arguments ?? {}, state, identity)));

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

  /**
   * Resolve the menu FRESH for every listing and every call. It is deliberately
   * not memoized: the registry behind the provider grows at runtime (an
   * `add()`), and a door that froze its menu at
   * the first request would leave every late-arriving tool invisible AND
   * uncallable until the process restarted. The registry memoizes its own load,
   * so re-asking costs a map lookup. A rejected resolution is likewise never
   * cached — a transient read failure must not permanently freeze the door.
   */
  async #menu(): Promise<Set<string> | undefined> {
    const configured = this.#config.menuTools;
    const names = typeof configured === "function" ? await configured() : configured;
    return names === undefined ? undefined : new Set(names);
  }

  async #listedTools(state: SessionState): Promise<Tool[]> {
    const menu = await this.#menu();
    // `ctx` is load-bearing, not decoration: the guard-bound registry answers
    // `descriptors(ctx)` with `projectableForRun(all, ctx)`, which is where THE
    // LAW (design §12) withholds destructive tools from an unattended run. The
    // door used to ask WITHOUT it (divergence 5), which is invisible while
    // `mcpContext` hardcodes `presence: "present"` and is a hole the moment any
    // context here can say otherwise. Not projected has to mean not projected.
    const descriptors = (await this.#config.tools.descriptors(state.context))
      .filter((descriptor) => offeredAtDoor(menu, descriptor.name, this.#withheld));
    const appsConfigured = this.#config.apps !== undefined;
    const compiles = wireSchemaCompiler();
    // The bound registry's descriptors are served VERBATIM — name, description,
    // and inputSchema are the registry's, never the door's (10-mcp §2/§4). But a
    // registry that owns an app-viewer name (e.g. vendo_apps_open from
    // apps.agentTools(), which the umbrella registers) must still advertise the
    // MCP Apps shim so the client preloads the renderer: we attach ONLY the
    // door's `_meta.ui` to those listings (FIX E). Execution still routes through
    // the registry (one guard decision), and #callTool unwraps its OpenSurface
    // output into a shim-renderable payload.
    const tools: Tool[] = descriptors.map(({ name, description, inputSchema, outputSchema, risk, title }) => {
      // A generated tools.json can carry title: "" (the authored file's schema
      // forbids it, the machine layer's does not). An empty label is worse than
      // none — a client would render a blank menu row — so it reads as absent.
      const label = title === undefined || title.trim() === "" ? undefined : title;
      const tool: Tool = {
        name,
        description,
        inputSchema: inputSchema as Tool["inputSchema"],
        ...wireOutputSchema(outputSchema, compiles),
        ...(label === undefined ? {} : { title: label }),
        annotations: toolAnnotations(risk, label),
      };
      if (appsConfigured && APP_TOOL_NAMES.has(name)) tool._meta = appUiMeta();
      return tool;
    });
    // The door's own ride-along tools are additions for the app-viewer names the
    // registry does NOT own (e.g. vendo_apps_list / vendo_apps_call when only
    // vendo_apps_open is registered) — a same-named registry tool keeps its
    // verbatim descriptor (with door `_meta` attached above) and is not duplicated.
    if (appsConfigured) {
      const taken = new Set(tools.map((tool) => tool.name));
      tools.push(...appTools().filter((tool) => !taken.has(tool.name) && !this.#withheld.has(tool.name)));
    }
    return tools;
  }

  async #callTool(
    name: string,
    args: Record<string, unknown>,
    state: SessionState,
    identity: HostIdentity,
  ): Promise<CallToolResult> {
    // 10-mcp §3b: a turn-bearing call is handed STRAIGHT to the live turn. The
    // door adds no guard decision, no audit row, no approval handling and no
    // menu of its own — `turn.tools.call()` is the in-process path, so this is
    // parity by construction rather than a second implementation of it. The
    // turn's own curation (the loadout, `surfaces.agent`, §12) already decided
    // what is callable, and an unknown name comes back as its own error.
    //
    // A WITHHELD name is the exception, because it is not curation: it is what
    // this door does not do, so it is refused here exactly as the OAuth leg
    // refuses it — not offered has to mean not callable on either leg.
    if (state.turn !== undefined) {
      if (this.#withheld.has(name)) return inBandError(`not-found: Tool ${name} was not found`);
      const turn = state.turn;
      const result = await turn.tools.call(name, args as Json);
      // The shim renders a bare format-tagged UIPayload, not the registry's
      // OpenSurface envelope — the same unwrap the OAuth leg does below. Both
      // legs share one mount and one `apps` config, so they cannot disagree
      // about whether a saved app renders.
      if (name === "vendo_apps_open" && this.#config.apps !== undefined && result.status === "ok") {
        return textResult(await this.#mcpAppsOpenOutput(result.output, args, turn.ctx, identity));
      }
      return turnResult(result);
    }
    const descriptors = await this.#config.tools.descriptors(state.context);
    // An off-menu name answers exactly like a name that does not exist: the
    // menu decides what this door OFFERS, and offering nothing is the whole
    // refusal (the guard, not the menu, is what stops a call that IS offered).
    const descriptor = descriptors.find((candidate) => candidate.name === name);
    if (!offeredAtDoor(await this.#menu(), name, this.#withheld) || descriptor === undefined) {
      // The apps ride-along path answers names the registry does not own, so it
      // has to honour the same withholding — otherwise a withheld viewer name
      // would be invisible on the listing and callable anyway.
      if (this.#config.apps !== undefined && APP_TOOL_NAMES.has(name) && !this.#withheld.has(name)) {
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
    return mapOutcome(outcome, identity.name, { descriptor, args });
  }

  /** The ride-along tools are door tool calls like any other (10-mcp §2/§4).
   * The door holds the core `Guard` seam (check/report) — not `VendoGuard.bind`
   * (that's already applied to `config.tools`) — so it runs the seam's own
   * decide → (maybe park) → execute → report here: guard.check parks on "ask",
   * VendoError codes are preserved, the call is audited. Output scanning is a
   * bind-internal stage not exposed on the seam, but it still runs where it
   * matters: the forwarded host-tool ref executes inside the runtime's own `call`, which
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
    // Args are judged BEFORE the guard is asked: a call that can never execute
    // must not mint a parked approval for a human to resolve.
    const invalid = appToolArgsError(name, args);
    if (invalid !== undefined) {
      return mapOutcome({ status: "error", error: { code: "validation", message: invalid } }, identity.name);
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
    // The tool already executed (and the replay entry was spent) by the time
    // the audit runs. A failing report must not replace the computed outcome
    // with a JSON-RPC protocol error (10-mcp §2: execution errors stay
    // in-band) — that would invite a retry that re-executes the write.
    try {
      await this.#config.guard.report({
        id: `aud_${randomHex(12)}`,
        at: new Date().toISOString(),
        kind: "tool-call",
        // A call arriving on a TURN credential carries that turn's ctx (§3b), so
        // the door's rows join to the turn exactly like the harness's own — which
        // is what the door-parity law ("identical audit rows") asks for. The
        // hand-copied block dropped it.
        ...auditContext(ctx),
        tool: name,
        inputPreview: appToolPreview(name, args),
        outcome: outcome.status,
        decidedBy: decision.decidedBy,
      });
    } catch (error) {
      log({
        code: "mcp.apps-tool-audit-failed",
        level: "error",
        message: "[vendo] mcp door: apps-tool audit report failed",
        data: {
          detail: {
            tool: name,
            outcome: outcome.status,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
    return mapOutcome(outcome, identity.name, { descriptor, args });
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
      const appId = args.appId as string;
      if (name === "vendo_apps_open") {
        const opened = await apps.open(appId, ctx);
        return { status: "ok", output: await this.#mcpAppsOpenOutput(opened, args, ctx, identity) as Json };
      }
      return { status: "ok", output: await apps.call(appId, args.ref as string, args.args as Json, ctx) };
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
    return projectAppsOpenOutput(output, { productName: identity.name, appName });
  }

  async #sweepIdleSessions(): Promise<void> {
    await this.#closeSessions(await this.#state.sweepExpiredSessions(Date.now()));
  }

  async #killSubject(subject: string): Promise<void> {
    await this.#closeSessions(await this.#state.deleteSessionsBySubject(subject));
  }

  async revokeClient(subject: string, clientId: string): Promise<void> {
    const oauth = this.#oauth;
    // An internal door issued no client anything; there is nothing to take back.
    if (oauth === undefined) return;
    await oauth.revokeClient(subject, clientId);
    await this.#killSubjectClient(subject, clientId);
    await oauth.auditRevoke(subject, clientId);
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
        // A transport already closing is exactly the state we want it in;
        // sweep and revocation both remain fail-closed regardless.
      }
    }
  }

  #hostIdentity(): Promise<HostIdentity> {
    this.#identity ??= readHostIdentity();
    return this.#identity;
  }
}

function endpointFor(path: string): {
  kind: "mcp" | "authorize" | "token" | "revoke" | "register" | "federate" | "connect";
  mount: string;
} {
  for (const [suffix, kind] of [
    ["/authorize", "authorize"],
    ["/token", "token"],
    ["/revoke", "revoke"],
    ["/register", "register"],
    ["/federate", "federate"],
    ["/connect", "connect"],
  ] as const) {
    if (path.endsWith(suffix)) return { kind, mount: path.slice(0, -suffix.length) };
  }
  return { kind: "mcp", mount: path };
}

/** A path that exists only to get an OUTSIDE agent a credential: the four
 *  discovery documents, the OAuth endpoints, and the connect page. An internal
 *  door serves none of them, so on one they are not paths at all. */
function outsideSpacePath(path: string): boolean {
  return path.startsWith(PRM_PREFIX)
    || path.startsWith(AS_PREFIX)
    || path === SERVER_CARD_PATH
    || path === SERVER_CARD_ALIAS_PATH
    || endpointFor(path).kind !== "mcp";
}

function normalizeMount(mount: string): string {
  if (!mount || mount === "/") return "";
  return `/${mount.replace(/^\/+|\/+$/g, "")}`;
}

/** Move a request onto the canonical public origin and path, preserving
 * everything else. The shape production hosts proved as a workaround
 * (runvendo/umami#1), now owned by the door itself. */
function rebaseRequest(req: Request, origin: string, pathname: string, incoming: URL): Request {
  const url = new URL(`${pathname}${incoming.search}`, origin);
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
    ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req.body, duplex: "half" }),
  };
  return new Request(url, init);
}

/** `base` is the full public base — origin plus the deployment's path prefix
 *  (or just the origin when there is none); `mount` is the door-local mount. */
function resourceUri(base: string, mount: string): string {
  return canonicalUri(`${base}${normalizeMount(mount)}`);
}

/** Prefix-LOCAL, not RFC 9728 root-insertion: a prefixed deployment owns no
 *  path outside its prefix, so a root well-known URL would never route to it.
 *  This URL is advertised explicitly (401 challenge, server card), and the
 *  door serves the root-insertion spelling too for clients that derive their
 *  own (the well-known handlers strip the prefix from the mount suffix). */
function protectedResourceMetadataUrl(base: string, mount: string): string {
  return canonicalUri(base) + PRM_PREFIX + normalizeMount(mount);
}

function protectedResourceMetadata(base: string, mount: string, remoteIssuer?: string) {
  const resource = resourceUri(base, mount);
  return {
    resource,
    authorization_servers: [remoteIssuer ?? resource],
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata(base: string, mount: string, serviceAuth: boolean) {
  const issuer = resourceUri(base, mount);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    revocation_endpoint: `${issuer}/revoke`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: ["read", "write"],
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      ...(serviceAuth ? [TOKEN_EXCHANGE_GRANT_TYPE] : []),
    ],
    // The service exchange is the only flow that presents a secret; the OAuth
    // clients this door registers are public and always will be.
    token_endpoint_auth_methods_supported: serviceAuth ? ["none", "client_secret_post"] : ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  };
}

function unauthorized(base: string, mount: string, tokenPresented: boolean): Response {
  const resourceMetadata = protectedResourceMetadataUrl(base, mount);
  const challenge = `Bearer resource_metadata="${resourceMetadata}"${tokenPresented ? ', error="invalid_token"' : ""}`;
  return json({ error: { code: "unauthorized", message: "A valid bearer token is required" } }, 401, {
    "www-authenticate": challenge,
  });
}

/** An INTERNAL door's only refusal. Deliberately WITHOUT a `www-authenticate`
 *  challenge: the challenge's whole job is to name the resource metadata a
 *  client registers against, and this door has none to name. */
function locked(): Response {
  return json({ error: { code: "unauthorized", message: "A valid bearer token is required" } }, 401);
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
    title: "List saved apps",
    description: "List the current user's saved Vendo apps",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "vendo_apps_open",
    title: "Open a saved app",
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
    title: "Use a saved app",
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

/** Vendo's own reserved tool namespace. A per-surface menu curates the HOST's
 *  API; the runtime's own tools (apps viewer, and anything else the umbrella
 *  registers under this prefix) are plumbing and are never curated away —
 *  the agent side of the same rule lives in the umbrella. Duplicated as a
 *  literal because block layering keeps mcp off the agent/actions packages. */
const VENDO_TOOL_PREFIX = "vendo_";

/**
 * Vendo's reserved namespace for keys the RUNTIME adds to a tool result — the
 * `toolOutputCap` truncation envelope (`vendo_truncated`/`vendo_chars`/
 * `vendo_preview`, minted in `packages/agent/src/tools.ts`) and
 * {@link VENDO_RESULT_VALUE} here. Reserved because the official client validates
 * every result against the advertised schema: a host declaring a field of the
 * same name and a different type would make its own tool throw on a truncated
 * answer. Which is also why the sanitizer drops declared `vendo_*` properties.
 */
const VENDO_RESULT_PREFIX = "vendo_";

/** The one key a NON-record ok output rides under. `structuredContent` must be an
 *  object, so a string, a number or a bare array needs a wrapper or it travels
 *  as text only — which the client reads as a broken server whenever the tool
 *  advertised a schema. */
const VENDO_RESULT_VALUE = `${VENDO_RESULT_PREFIX}value`;

/** Whether a curated door offers `name`. Asked by BOTH the listing and the call
 *  path, so a curated door cannot advertise one surface and answer to another.
 *
 *  `withheld` is checked FIRST, ahead of the `vendo_` bypass: the bypass exists
 *  so a HOST's menu cannot delete Vendo's plumbing, while the withhold list is
 *  the deployment's own decision about its own door. */
function offeredAtDoor(menu: Set<string> | undefined, name: string, withheld: ReadonlySet<string>): boolean {
  if (withheld.has(name)) return false;
  return menu === undefined || name.startsWith(VENDO_TOOL_PREFIX) || menu.has(name);
}

/**
 * 10-mcp §2 — the MCP annotation hints derived from Vendo's ONE risk label, so
 * a client can warn a person before a write and colour a destructive call
 * without re-deriving intent from prose. Hints only: the guard is what actually
 * decides, and a client is free to ignore these (per the MCP spec). `title`
 * rides along here too — the spec moved it to a top-level field, but clients
 * that predate that move still read `annotations.title`, so the door emits
 * both and neither can drift from the other.
 *
 * `ungraded` asserts NEITHER hint. MCP's own default for `destructiveHint` is
 * `true`, so emitting `false` was an active claim of safety about a tool nobody
 * judged — the exact guess the risk-grading redesign deleted everywhere else.
 * `true` would be the opposite guess and just as unfounded, and `readOnlyHint:
 * false` claims "modifies its environment", also unknown. Omitted, the client
 * falls back to the spec's own conservative defaults and the door says nothing
 * it cannot support.
 */
function toolAnnotations(risk: RiskLabel, title?: string): NonNullable<Tool["annotations"]> {
  return {
    ...(title === undefined ? {} : { title }),
    ...(risk === "ungraded" ? {} : { readOnlyHint: risk === "read", destructiveHint: risk === "destructive" }),
  };
}

/** ~32KiB of serialized JSON Schema, in BYTES on the wire (a CJK-labelled schema
 *  is ~3x its `.length`). A generated response schema can be an entire inlined
 *  OpenAPI response model, and every `tools/list` pays for it — the model's
 *  context first. Past the cap the door says nothing rather than everything,
 *  exactly as it does for a shape it cannot state. */
const OUTPUT_SCHEMA_CAP = 32 * 1024;

const utf8 = new TextEncoder();

/**
 * Keywords dropped from the TOP level of a sanitized output schema: each one can
 * reject an object over keys the schema never mentions, which is exactly what the
 * door substitutes when it cannot return what the host declared (the
 * `toolOutputCap` truncation envelope, the `vendo_value` wrapper). Every entry was
 * proven against the official client's own Ajv validator; a swept run over the
 * rest of the family found nothing else to add.
 *
 * Top level ONLY: a nested constraint applies to the value of a field the host
 * declared, so it can only reject the host's own result, never a reserved-key
 * envelope whose keys no host schema mentions.
 *
 * Four reject WITHOUT ever naming a key, which is why a "does it mention a
 * reserved name?" check could never have found them:
 * - `patternProperties` types keys by REGEX, and `"^.*$"` types every key there is.
 * - `$ref`/`$dynamicRef` reach around this whole strip — a top-level `$ref` into
 *   `$defs` re-imposes the `required` and closed `additionalProperties` deleted
 *   here. (`$defs` itself stays: an unreferenced definition constrains nothing.)
 * - `const`/`enum` pin the WHOLE object to a listed value, so the strip above them
 *   is beside the point.
 */
const UNKEEPABLE_KEYWORDS = [
  "required",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "unevaluatedProperties",
  "patternProperties",
  "$ref",
  "$dynamicRef",
  "const",
  "enum",
] as const;

/**
 * The tool's declared result shape on the wire (design 2026-08-03 D5) so the
 * model knows a query's fields before calling it — SANITIZED, because the
 * official MCP client turns the declaration into three hard promises and the
 * door has to be able to keep all three.
 *
 * 1. `tools/list` is parsed with the SDK's `ToolSchema`, whose `outputSchema` is
 *    `{ type: "object", properties?: Record<string, object>, required?: string[] }`.
 *    A top-level `{"type":"array"}` (ordinary in an OpenAPI spec) or a boolean
 *    property subschema (`{"x": true}` — legal JSON Schema 2020-12) fails that
 *    parse and takes the WHOLE listing down, every other tool with it. So the
 *    shape is checked here, and a schema that cannot be stated is omitted.
 * 2. `cacheToolMetadata` (run on every successful `listTools()`) COMPILES every
 *    advertised schema with Ajv, and a compile throw likewise kills the entire
 *    listing. A shape check cannot see that: a dangling `$ref` (extraction leaves
 *    one for recursive response models — `actions/src/sync/openapi.ts`),
 *    `{"type":"bogus"}` and Swagger 2.0's boolean `exclusiveMinimum` are all
 *    well-shaped and all throw, so the door asks the client's own validator.
 * 3. `tools/call` THROWS on any non-`isError` result whose `structuredContent` is
 *    missing or fails the advertised schema — and the door cannot promise the
 *    host's declaration describes every result it must return (`toolOutputCap`'s
 *    truncation envelope, the `vendo_value` wrapper). So `additionalProperties` is
 *    forced open, {@link UNKEEPABLE_KEYWORDS} is dropped, and so is any declared
 *    property in the reserved `vendo_` namespace. Field names and types survive —
 *    the whole of D5's value to the model; what dies is the schema's power to
 *    REJECT a result the door has no choice about.
 *
 * The descriptor still carries the original for the in-process surfaces, which
 * have no wire constraint.
 */
function wireOutputSchema(
  schema: Record<string, unknown> | undefined,
  compiles: (wire: Record<string, unknown>, serialized: string) => boolean,
): { outputSchema?: Tool["outputSchema"] } {
  if (!isRecord(schema) || schema.type !== "object") return {};
  if (schema.properties !== undefined && !isObjectValued(schema.properties)) return {};
  // `type` is respelled (not re-ordered — the key keeps its place) so the wire
  // shape is the literal the SDK's schema demands without a cast.
  const wire: Record<string, unknown> = { ...schema, type: "object", additionalProperties: true };
  for (const keyword of UNKEEPABLE_KEYWORDS) delete wire[keyword];
  if (isRecord(wire.properties)) {
    wire.properties = Object.fromEntries(
      Object.entries(wire.properties).filter(([field]) => !field.startsWith(VENDO_RESULT_PREFIX)),
    );
  }
  // A host schema can be cyclic (an OpenAPI model inlined into itself), which
  // throws inside the listing map — one tool's schema is never worth the listing.
  const serialized = tryStringify(wire);
  if (serialized === undefined) return {};
  // `.length` is UTF-16 units and can only UNDER-count bytes, so it is a free
  // pre-reject before the encode.
  if (serialized.length > OUTPUT_SCHEMA_CAP || utf8.encode(serialized).length > OUTPUT_SCHEMA_CAP) return {};
  if (!compiles(wire, serialized)) return {};
  return { outputSchema: wire as Tool["outputSchema"] };
}

/**
 * "Would the official client compile this?", asked with the client's own
 * validator — `Client` defaults to `AjvJsonSchemaValidator`, which the door
 * already carries. It earns its keep beyond the hand-listable throwers: a
 * `pattern` carrying a Python-style named group, ordinary in a generated OpenAPI
 * spec, is a compile throw no shape check would catch.
 *
 * ONE Ajv instance per listing pass, then discarded: Ajv memoizes every compiled
 * schema keyed by the schema OBJECT, and the door builds a fresh wire object per
 * listing, so a door-lifetime instance would grow without bound. The VERDICT
 * carries across listings instead ({@link compileVerdicts}), keyed on the
 * serialized schema this pass already computed for the size cap — compiling is the
 * expensive half and it is pure (1370ms for 301 schemas, on EVERY `tools/list`).
 *
 * On a runtime that forbids code generation (Workers et al) Ajv compiles nothing,
 * so no schema is advertised there and the door says so once. Same rule as the
 * size cap, and the safe direction: an unaskable schema is exactly the one that
 * took a client's whole listing down.
 */
function wireSchemaCompiler(): (wire: Record<string, unknown>, serialized: string) => boolean {
  let validator: AjvJsonSchemaValidator | undefined;
  return (wire, serialized) => {
    const cached = compileVerdicts.get(serialized);
    if (cached !== undefined) return cached;
    try {
      validator ??= new AjvJsonSchemaValidator();
      validator.getValidator(wire as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
      return rememberVerdict(serialized, true);
    } catch (error) {
      if (error instanceof EvalError && !codegenWarned) {
        codegenWarned = true;
        log({
          code: "mcp.output-schema-validation-off",
          level: "warn",
          message:
            "[vendo] mcp door: this runtime forbids code generation, so declared tool output schemas "
            + "cannot be validated before they are advertised and are omitted from tools/list. "
            + "Tools still list and still run; the model just loses the declared result fields.",
        });
      }
      return rememberVerdict(serialized, false);
    }
  };
}

/** Once per process: a runtime without code generation is a deployment fact, not
 *  a per-listing event. */
let codegenWarned = false;

/**
 * "Does this exact schema compile?", remembered across listings and sessions. A
 * pure function of the serialized schema, so the answer never goes stale — a
 * schema that changes is a different key.
 *
 * Bounded by the BYTES it holds, not by entry count: the key IS the schema text,
 * up to {@link OUTPUT_SCHEMA_CAP} of it each. Over the cap a pathological surface
 * just recompiles, the behaviour before this cache existed. Oldest evicted first;
 * there is no recency to protect, because a listing re-reads the whole set.
 */
const compileVerdicts = new Map<string, boolean>();
const VERDICT_CACHE_BYTES = 4 * 1024 * 1024;
let verdictBytes = 0;

function rememberVerdict(serialized: string, verdict: boolean): boolean {
  compileVerdicts.set(serialized, verdict);
  verdictBytes += serialized.length;
  while (verdictBytes > VERDICT_CACHE_BYTES) {
    const oldest = compileVerdicts.keys().next();
    if (oldest.done === true) break;
    compileVerdicts.delete(oldest.value);
    verdictBytes -= oldest.value.length;
  }
  return verdict;
}

/** The client's `ToolSchema` asserts every `properties` value is an OBJECT, so a
 *  boolean subschema is legal JSON Schema the wire cannot carry. */
function isObjectValued(value: unknown): boolean {
  return isRecord(value)
    && Object.values(value).every((entry) => typeof entry === "object" && entry !== null);
}

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
  return APP_TOOL_DESCRIPTORS.map(({ name, title, description, inputSchema, risk }) => ({
    name,
    ...(title === undefined ? {} : { title }),
    description,
    inputSchema: inputSchema as Tool["inputSchema"],
    annotations: toolAnnotations(risk, title),
    _meta: appUiMeta(),
  }));
}

/** The Authorization header's bearer, or undefined. Case-insensitive scheme,
 *  because clients differ and the door already accepts both spellings today. */
function bearerOf(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The live turn's EQUIPPED listing, as MCP tools.
 *
 * `turn.tools.list()` is already the curated, ctx-projected surface — the
 * loadout, `find_tools`' searched-in set, the host's `surfaces.agent` menu and
 * THE LAW's §12 withholding all decided it. The door re-decides none of that:
 * re-applying its own `surfaces.mcp` menu here would curate a CHAT turn's tools
 * by the MCP door's list, which is the wrong menu for the wrong surface.
 *
 * `withheld` is the exception, and it is not a menu: it is what THIS door, as
 * deployed, does not do, so it holds on every leg of the mount.
 *
 * Asked fresh on every `tools/list`, so a tool `find_tools` equipped mid-turn is
 * visible without reopening anything — the limitation that made the in-process
 * projection snapshot its tool set at session open dies here.
 */
async function turnTools(
  turn: LiveTurn,
  withheld: ReadonlySet<string>,
  appsConfigured: boolean,
): Promise<Tool[]> {
  const listings = (await turn.tools.list()).filter((listing) => !withheld.has(listing.name));
  const compiles = wireSchemaCompiler();
  return listings.map((listing) => {
    const label = listing.title === undefined || listing.title.trim() === "" ? undefined : listing.title;
    return {
      name: listing.name,
      description: listing.description,
      inputSchema: (listing.inputSchema ?? { type: "object", properties: {} }) as Tool["inputSchema"],
      ...wireOutputSchema(listing.outputSchema, compiles),
      ...(label === undefined ? {} : { title: label }),
      annotations: toolAnnotations(listing.risk, label),
      // Same as the OAuth leg: an app-viewer name the turn's registry owns has
      // to advertise the shim, or the client never preloads the renderer.
      ...(appsConfigured && APP_TOOL_NAMES.has(listing.name) ? { _meta: appUiMeta() } : {}),
    };
  });
}

/**
 * Contract §1.1's three statuses onto the MCP wire — the same mapping the
 * (now-retired) in-process projection used before door-ctx moved tools here:
 * a denial is text the model narrates, never a protocol error it reads as a bug.
 */
function turnResult(result: ToolResult): CallToolResult {
  if (result.status === "ok") return textResult(result.output);
  if (result.status === "denied") return inBandError(result.reason);
  return inBandError(`${result.error.code}: ${result.error.message}`);
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

/** AppsRuntime.open has already resolved every tree query into `tree.data`
 * (06-apps §1). The query declarations remain on the in-product payload so a
 * later open/refresh can resolve them again, but forwarding them to the MCP
 * shim would execute every query a second time. Project the already-resolved
 * payload immutably and keep the shim resolver only as a compatibility fallback
 * for non-door hosts that send unresolved trees directly. */
function projectAppsOpenOutput(
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
  // FIX E — the registry's vendo_apps_open returns an OpenSurface envelope
  // (`{ kind: "tree", payload } | { kind: "http", url } | { kind: "resuming" }`);
  // the door's own apps path projects that same envelope. Unwrap tree surfaces
  // so a registry-executed open renders identically over MCP Apps. HTTP
  // surfaces take the explicitly-tagged link-out projection above. A
  // `resuming` (or any other shape) passes through untouched — the shim's
  // core-§8 dispatch contains an unrenderable payload gracefully.
  const payload = isRecord(output) && output.kind === "tree" ? output.payload : output;
  if (!isRecord(payload) || payload.formatVersion !== "vendo-genui/v2" || !Object.hasOwn(payload, "queries")) {
    return payload;
  }
  const projected = { ...payload };
  delete projected.queries;
  return projected;
}
function replayKey(tool: string, args: Record<string, unknown>): string {
  return `${tool}\0${canonicalJson(args)}`;
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

/** The ride-along tools' argument contract, as one refusal reason or none. */
function appToolArgsError(name: string, args: Record<string, unknown>): string | undefined {
  if (name === "vendo_apps_list") return undefined;
  if (typeof args.appId !== "string" || args.appId === "") return "appId is required";
  if (name === "vendo_apps_open") return undefined;
  if (typeof args.ref !== "string" || args.ref === "") return "ref is required";
  if (!Object.hasOwn(args, "args")) return "args is required";
  return undefined;
}

function appToolPreview(name: string, args: Record<string, unknown>): string {
  const preview = `${name} ${stringify(args)}`;
  return preview.length > 500 ? `${preview.slice(0, 499)}…` : preview;
}

/**
 * Keep a long tools/call alive on the CLIENT's clock, for a client that asked
 * to be kept alive by sending a progressToken. The beat rides the standalone
 * stream — `notification()` with no relatedRequestId — because the door answers
 * POSTs with `enableJsonResponse`, and the transport drops a request-related
 * notification when there is no SSE body to write it to.
 */
async function withProgress<T>(
  server: Server,
  progressToken: ProgressToken | undefined,
  call: () => Promise<T>,
): Promise<T> {
  if (progressToken === undefined) return call();
  let progress = 0;
  // Rejects only once the client is already gone, which the call's own result
  // reports; an unawaited beat must not surface as an unhandled rejection.
  const beat = () => void server.notification({
    method: "notifications/progress",
    params: { progressToken, progress: ++progress },
  }).catch(() => {});
  beat();
  const timer = setInterval(beat, PROGRESS_HEARTBEAT_MS);
  try {
    return await call();
  } finally {
    clearInterval(timer);
  }
}

function mapOutcome(
  outcome: ToolOutcome,
  productName: string,
  /** The call being answered. Present at both sites that can park, so a
   *  `pending-approval` always carries its typed ref; absent only where the
   *  outcome is statically not a park (an ok output, a refused argument). */
  call?: { descriptor: ToolDescriptor; args: unknown },
): CallToolResult {
  switch (outcome.status) {
    case "ok":
      return textResult(outcome.output);
    case "error":
      return inBandError(`${outcome.error.code}: ${outcome.error.message}`);
    case "pending-approval":
      return {
        ...inBandError(
          `This action needs approval. Approval ${outcome.approvalId} is waiting in ${productName}'s Vendo approvals queue — resolve it there, then retry.`,
        ),
        // The prose is what the MODEL reads and must not move. The typed ref is
        // for the CODE around it: an outside loop collects `vendo/approval-ref@1`
        // off `structuredContent` instead of regexing an id out of English, and
        // the line it renders is the same one the in-process tool pack mints
        // (core's `vendoApprovalRef` is the single producer). Safe on an
        // `isError` result: the official client compiles an `outputSchema`
        // validator for OK results only — see the note above `textResult`.
        ...(call === undefined
          ? {}
          : { structuredContent: { ...vendoApprovalRef(outcome.approvalId, call.descriptor, call.args) } }),
      };
    case "blocked":
      return inBandError(outcome.reason);
    case "connect-required":
      // The door has no browser surface to run an OAuth redirect through; the
      // user connects the account in the product and retries here.
      return inBandError(
        `${outcome.connect.message} Open ${productName} and connect your ${outcome.connect.toolkit} account in settings, then retry.`,
      );
  }
}

/**
 * An ok result on the wire. A record rides as `structuredContent` verbatim; a
 * non-record output — a string, a number, a bare array — rides under
 * {@link VENDO_RESULT_VALUE}, because `structuredContent` must be an object.
 *
 * UNCONDITIONALLY, without asking whether this tool advertised a schema. The
 * official client reads an advertised `outputSchema` as a guarantee (an ok result
 * with no conforming `structuredContent` makes `callTool` THROW) and permits
 * `structuredContent` with no schema advertised at all — it compiles no validator,
 * so it never looks. Asking cost a `tools/list` AFTER the write had executed,
 * where a throw turns a committed call into a failure the model believes, and it
 * could only answer for the listing as it is NOW rather than the one the client
 * cached.
 */
function textResult(output: unknown): CallToolResult {
  const text = isOpenInProductPayload(output)
    ? `Open ${output.appName ?? "this app"} in ${output.productName}: ${output.url}`
    : stringify(output);
  return {
    content: [{ type: "text", text }],
    structuredContent: isRecord(output) ? output : { [VENDO_RESULT_VALUE]: output },
  };
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

/** JSON, or undefined for a value that cannot be serialized at all — a cyclic
 *  host schema, a BigInt. The caller decides what an unstateable value means. */
function tryStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return undefined;
  }
}

function mcpContext(
  principal: Principal,
  sessionId: string,
  consent: { clientId: string; scopes: string[] },
  memberships?: Membership[],
): McpRunContext {
  return {
    principal,
    venue: "mcp",
    presence: "present",
    sessionId,
    mcpConsent: consent,
    // §9.1 — asserted, never stored, and absent when the host asserts nothing.
    ...(memberships === undefined ? {} : { memberships }),
  };
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

/** The declaration-block serialization of core's one theme→CSS-variable mapping. */
function themeDeclarations(theme: VendoTheme): string {
  return Object.entries(themeCssVariables(theme))
    .map(([name, value]) => `${name}:${escapeCssValue(value)};`)
    .join("");
}

function escapeCssValue(value: string): string {
  return value.replace(/[\0-\x1f\x7f\\;{}<>]/g, (character) =>
    `\\${character.codePointAt(0)!.toString(16)} `);
}

async function readHostIdentity(): Promise<HostIdentity> {
  const fallback = { name: "vendo", version: "0.0.0", description: "Vendo MCP server" };
  const path = typeof process === "undefined" ? undefined : `${process.cwd()}/package.json`;
  // The generic fallback used to be machine-only (a server-card field). The
  // connect page puts it in front of a person, where "vendo" reads as a bug in
  // the host's product. Say so once, naming the file that was tried.
  const warnFallback = (reason: string): HostIdentity => {
    if (!identityFallbackWarned) {
      identityFallbackWarned = true;
      log({
        code: "mcp.product-name-unresolved",
        level: "warn",
        message:
          `[vendo] mcp door: could not read a product name from ${path ?? "the host package"} (${reason}); `
          + "the server card and the connect page will say \"vendo\". Set `name` in the host's "
          + "package.json or run the door from the host's package root.",
      });
    }
    return fallback;
  };
  try {
    if (path === undefined) return warnFallback("no filesystem on this runtime");
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof pkg.name !== "string") return warnFallback("it declares no name");
    const name = pkg.name;
    const version = typeof pkg.version === "string" ? pkg.version : fallback.version;
    const description = typeof pkg.description === "string" ? pkg.description : `${name} MCP server`;
    return { name, version, description };
  } catch (error) {
    return warnFallback(error instanceof Error ? error.message : String(error));
  }
}

/** Once per process: a missing product name is a deployment fact, not a
 *  per-request event. */
let identityFallbackWarned = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "error";
}
