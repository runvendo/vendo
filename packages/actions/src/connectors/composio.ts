import { debugConnectorHttp, joinUrl, VendoError, type RiskLabel, type RunContext, type ToolCall, type ToolDescriptor, type ToolOutcome } from "@vendoai/core";
import type { Connector, ConnectorAccount, ConnectorAccountIdentity, ConnectorCatalogEntry, ServiceToolMatch } from "./connector.js";
import { composioToolRisk } from "./composio-risk.js";
import { normalizeToolName } from "./names.js";

interface ComposioTool {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  toolkit_slug?: unknown;
  toolkit?: { slug?: unknown };
  input_parameters?: unknown;
  tags?: unknown;
}

interface ComposioPage {
  items?: unknown;
  data?: { items?: unknown; next_cursor?: unknown } | unknown;
  next_cursor?: unknown;
}

/** `POST /api/v3.1/tool_router/session/{id}/search`. Matches arrive as bare
 * SLUG LISTS; schemas and connection status ride alongside in their own maps,
 * so a row the model can act on has to be assembled from all three. */
interface ComposioSearchResponse {
  results?: Array<{ primary_tool_slugs?: unknown; related_tool_slugs?: unknown }>;
  toolkit_connection_statuses?: Array<{
    toolkit?: unknown;
    has_active_connection?: unknown;
    status_message?: unknown;
  }>;
}

interface ComposioConnectedAccount {
  id?: unknown;
  toolkit?: { slug?: unknown };
  status?: unknown;
  created_at?: unknown;
}

const MAX_PAGES = 50;

/** Auth configs change on dashboard timescales; thread mounts must not
 * re-walk them. */
const CONNECTABLE_CACHE_TTL_MS = 5 * 60_000;

/** Composio's deterministic missing-connection signal on tool execution. */
const NO_CONNECTED_ACCOUNT_SLUG = "ActionExecute_ConnectedAccountNotFound";

/** How many matches one `find_service_tools` answers with.
 *
 * Composio's session search takes NO limit/top_k parameter (verified against
 * their API reference 2026-08-03), so the cap has to be ours: an unbounded
 * result set is a prompt-budget hazard, and we fetch one schema per row.
 *
 * This bounds the READ. What the model is handed is bounded by SIZE, one layer
 * up in `find_service_tools`, because ten of their schemas do not fit a default
 * tool-output cap even trimmed. */
const MAX_MATCHES = 10;

/** THE TOOL PLANE SPEAKS ONE VERSION. Every call that names a tool — the
 * tool-router session, its search, the schema reads, the listing walk and the
 * EXECUTOR — goes through this constant, because v3 and v3.1 are different
 * catalogs and reading one while executing on the other is a live defect: the
 * search hands the model a slug and the executor answers "Tool X not found".
 * Live-measured 2026-08-03, of 42 slugs their v3.1 search returned for eight
 * ordinary needs, 19 (45%) do not execute on v3 at all — every Outlook mail
 * action, every `COMPOSIO_SEARCH_*`, five `TEXT_TO_PDF_*`. It runs the other
 * way too: v3 carries legacy names (`OUTLOOK_OUTLOOK_CREATE_DRAFT`,
 * `COMPOSIO_SEARCH_NEWS_SEARCH`) that v3.1 has renamed, so a v3 listing feeding
 * a v3.1 executor breaks just as badly. v3.1 is the side that has the
 * tool-router at all, so v3.1 is the side everything moves to.
 *
 * Do not add a tool-plane call that does not use this constant. */
const TOOLS_BASE = "/api/v3.1";

/** The ACCOUNTS plane stays pinned to v3 (connected accounts, auth configs).
 * Live-probed 2026-08-03: v3 and v3.1 answer these byte-identically — same
 * fields, same 50-item clamp with a page-number cursor, same link/delete
 * behaviour, same `user_ids` isolation — so there is nothing to gain, and this
 * plane has no catalog to skew against: an account is an account in either
 * version, and the toolkit slugs it is keyed by are shared. Moving it would
 * only put the cross-principal ownership check on a freshly-changed path. */
const ACCOUNTS_BASE = "/api/v3";

/** Composio ships documentation for PEOPLE inside the machine schema —
 * `examples`, and a `human_parameter_*` restatement of every description — and
 * it is roughly a third of the bytes: measured against their live catalog
 * 2026-08-03, eight email matches serialize to 36,407 chars whole and 24,736
 * with these gone. None of it is needed to construct a call; the real
 * `description` stays. */
const HUMAN_FACING_KEYWORDS = new Set(["examples", "human_parameter_name", "human_parameter_description"]);

/** JSON Schema keywords whose values are maps of NAME → schema. A parameter may
 * legitimately be called `examples`, and dropping it would be dropping an
 * argument, so the trim below only ever removes a KEYWORD. */
const SCHEMA_NAME_MAPS = new Set(["properties", "patternProperties", "definitions", "$defs"]);

function withoutHumanCopy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutHumanCopy);
  if (node === null || typeof node !== "object") return node;
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (HUMAN_FACING_KEYWORDS.has(key)) continue;
    if (SCHEMA_NAME_MAPS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const named: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(value as Record<string, unknown>)) {
        named[name] = withoutHumanCopy(schema);
      }
      trimmed[key] = named;
      continue;
    }
    trimmed[key] = withoutHumanCopy(value);
  }
  return trimmed;
}

function errorOutcome(message: string): ToolOutcome {
  return { status: "error", error: { code: "connector-error", message } };
}

function withIdentity(outcome: ToolOutcome, identity: ConnectorAccountIdentity): ToolOutcome {
  return Object.assign({}, outcome, { connectorAccount: identity });
}

function pageParts(payload: ComposioPage): { items: unknown[]; nextCursor?: string } {
  const nested =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as { items?: unknown; next_cursor?: unknown })
      : undefined;
  const rawItems = payload.items ?? nested?.items ?? (Array.isArray(payload.data) ? payload.data : undefined);
  if (!Array.isArray(rawItems)) throw new Error("Composio response did not contain an items array");
  const cursor = payload.next_cursor ?? nested?.next_cursor;
  return {
    items: rawItems,
    nextCursor: typeof cursor === "string" && cursor.length > 0 ? cursor : undefined,
  };
}

interface ComposioErrorBody {
  error?: { message?: unknown; slug?: unknown; code?: unknown } | string;
}

function responseErrorParts(payload: unknown): { message?: string; slug?: string; code?: number } {
  if (!payload || typeof payload !== "object") return {};
  const error = (payload as ComposioErrorBody).error;
  if (typeof error === "string") return { message: error };
  if (!error || typeof error !== "object") return {};
  return {
    ...(typeof error.message === "string" && error.message ? { message: error.message } : {}),
    ...(typeof error.slug === "string" && error.slug ? { slug: error.slug } : {}),
    ...(typeof error.code === "number" ? { code: error.code } : {}),
  };
}

function accountStatus(status: unknown): ConnectorAccount["status"] {
  if (status === "ACTIVE") return "active";
  if (status === "INITIALIZING" || status === "INITIATED") return "initiated";
  if (status === "EXPIRED") return "expired";
  return "failed";
}

export function composioConnector(config: {
  apiKey: string;
  entityId?: (ctx: RunContext) => string;
  apps?: string[];
  baseUrl?: string;
}): Connector {
  const baseUrl = config.baseUrl ?? "https://backend.composio.dev";
  let normalizedToRaw = new Map<string, { raw: string; toolkit: string }>();

  async function composioFetch(
    path: string,
    options: { method?: string; query?: Record<string, string>; body?: Record<string, unknown> } = {},
  ): Promise<{ ok: boolean; status: number; payload: unknown }> {
    const url = joinUrl(baseUrl, path);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    debugConnectorHttp("composio", options.method ?? "GET", path);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "x-api-key": config.apiKey,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Composio ${path} response was not valid JSON (${response.status})`);
    }
    return { ok: response.ok, status: response.status, payload };
  }

  /** Walk a cursor-paginated Composio listing to completion (fail-closed on
   * cursor loops and runaway page counts). */
  async function paginate(
    path: string,
    label: string,
    query: (cursor?: string) => Record<string, string>,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await composioFetch(path, { query: query(cursor) });
      if (!response.ok) {
        const { message } = responseErrorParts(response.payload);
        throw new Error(`${label} request failed with ${response.status}: ${message ?? ""}`.trim());
      }
      const parsed = pageParts(response.payload as ComposioPage);
      items.push(...parsed.items);
      cursor = parsed.nextCursor;
      if (!cursor) return items;
      if (seenCursors.has(cursor)) throw new Error(`Composio pagination loop at cursor ${cursor}`);
      seenCursors.add(cursor);
    }

    throw new Error(`${label} pagination exceeded ${MAX_PAGES} pages`);
  }

  async function fetchTools(app?: string): Promise<ComposioTool[]> {
    const items = await paginate(`${TOOLS_BASE}/tools`, "Composio tools", (cursor) => ({
      // Composio's real catalog is 1,000+ toolkits and 20,000+ tools
      // (docs.composio.dev/toolkits). An unscoped fetch (bare `apps`)
      // walks that whole catalog, so every page requests the API's max
      // page size — 1000, per docs.composio.dev/reference/api-reference/
      // tools/getTools — to keep the walk inside MAX_PAGES regardless of
      // whatever smaller default the API would otherwise apply.
      limit: "1000",
      ...(app === undefined ? {} : { toolkit_slug: app }),
      ...(cursor === undefined ? {} : { cursor }),
    }));
    return items as ComposioTool[];
  }

  /** Connected accounts scoped to ONE subject. Every Composio read filters by
   * user_ids=subject so one principal can never observe another's accounts. */
  async function listAccounts(subject: string, connectedAccountId?: string): Promise<ConnectorAccount[]> {
    const items = await paginate(`${ACCOUNTS_BASE}/connected_accounts`, "Composio connected-accounts", (cursor) => ({
      user_ids: subject,
      ...(connectedAccountId === undefined ? {} : { connected_account_ids: connectedAccountId }),
      ...(cursor === undefined ? {} : { cursor }),
    }));
    const accounts: ConnectorAccount[] = [];
    for (const item of items as ComposioConnectedAccount[]) {
      if (typeof item.id !== "string" || typeof item.toolkit?.slug !== "string") continue;
      accounts.push({
        id: item.id,
        connector: "composio",
        toolkit: item.toolkit.slug,
        status: accountStatus(item.status),
        ...(typeof item.created_at === "string" ? { createdAt: item.created_at } : {}),
      });
    }
    return accounts;
  }

  let connectableCache: { at: number; entries: ConnectorCatalogEntry[] } | undefined;

  const toolkitToolCache = new Map<string, Promise<ComposioTool[]>>();

  function toolkitTools(toolkit: string): Promise<ComposioTool[]> {
    let promise = toolkitToolCache.get(toolkit);
    if (!promise) {
      promise = fetchTools(toolkit);
      toolkitToolCache.set(toolkit, promise);
    }
    return promise;
  }

  /** One tool-router session per SUBJECT. Composio's search and its connect
   * links are session-scoped and a session is bound to one `user_id`, so a
   * shared session would search and link as the wrong person. Their docs state
   * sessions do not expire and advise reusing one across a conversation, which
   * is what this memo does; a failed create is not cached. */
  const sessions = new Map<string, Promise<string>>();

  function sessionFor(subject: string): Promise<string> {
    let session = sessions.get(subject);
    if (session === undefined) {
      session = (async () => {
        const response = await composioFetch(`${TOOLS_BASE}/tool_router/session`, {
          method: "POST",
          body: { user_id: subject },
        });
        if (!response.ok) {
          const { message } = responseErrorParts(response.payload);
          throw new Error(`Composio session create failed with ${response.status}: ${message ?? ""}`.trim());
        }
        const id = (response.payload as { session_id?: unknown }).session_id;
        if (typeof id !== "string" || id.length === 0) {
          throw new Error("Composio session create returned no session id");
        }
        return id;
      })();
      sessions.set(subject, session);
      session.catch(() => {
        if (sessions.get(subject) === session) sessions.delete(subject);
      });
    }
    return session;
  }

  /** Everything a slug needs to be CALLED, learned once and remembered: search
   * populates it for every row it returns, so the `use_service_tool` that
   * follows costs no extra lookup. A slug the model names out of nowhere still
   * resolves — `toolDetails` falls back to a single-slug read. */
  const slugCache = new Map<string, {
    toolkit: string;
    description: string;
    tags?: string[];
    inputSchema?: Record<string, unknown>;
  }>();

  function rememberTool(item: ComposioTool): string | undefined {
    const slug = typeof item.slug === "string" ? item.slug : undefined;
    const toolkit = typeof item.toolkit_slug === "string"
      ? item.toolkit_slug
      : typeof item.toolkit?.slug === "string" ? item.toolkit.slug : undefined;
    if (slug === undefined || toolkit === undefined) return undefined;
    const tags = Array.isArray(item.tags)
      ? (item.tags as unknown[]).filter((tag): tag is string => typeof tag === "string")
      : undefined;
    const inputSchema = item.input_parameters
      && typeof item.input_parameters === "object"
      && !Array.isArray(item.input_parameters)
      ? (withoutHumanCopy(item.input_parameters) as Record<string, unknown>)
      : undefined;
    slugCache.set(slug, {
      toolkit,
      description: typeof item.description === "string" && item.description ? item.description : slug,
      ...(tags === undefined ? {} : { tags }),
      ...(inputSchema === undefined ? {} : { inputSchema }),
    });
    return slug;
  }

  /** Full records for a batch of slugs — schema AND risk tags in one read.
   * `tool_slugs` is documented as OVERRIDING every other filter, so it travels
   * alone. Unknown slugs are simply absent from the answer. */
  async function loadTools(slugs: string[]): Promise<void> {
    if (slugs.length === 0) return;
    const response = await composioFetch(`${TOOLS_BASE}/tools`, {
      query: { tool_slugs: slugs.join(",") },
    });
    if (!response.ok) {
      const { message } = responseErrorParts(response.payload);
      throw new Error(`Composio tool-schema request failed with ${response.status}: ${message ?? ""}`.trim());
    }
    for (const item of pageParts(response.payload as ComposioPage).items as ComposioTool[]) rememberTool(item);
  }

  /** One slug's record, cache-first. `undefined` means Composio does not have
   * it — the caller turns that into "call find_service_tools first", never a
   * guess at what the model meant. */
  async function toolDetails(slug: string): Promise<{ toolkit: string; tags?: string[] } | undefined> {
    const cached = slugCache.get(slug);
    if (cached !== undefined) return cached;
    const response = await composioFetch(`${TOOLS_BASE}/tools/${encodeURIComponent(slug)}`);
    if (!response.ok) return undefined;
    return rememberTool(response.payload as ComposioTool) === undefined ? undefined : slugCache.get(slug);
  }

  /** The dock catalog: the host's `apps` scoping verbatim when set, else the
   * distinct toolkits with an enabled auth config — exactly the set a user
   * can finish connecting (initiate refuses anything else). Host-level, so
   * the auth-config walk is cached across principals. */
  async function listConnectable(): Promise<ConnectorCatalogEntry[]> {
    if (config.apps !== undefined) return config.apps.map((toolkit) => ({ toolkit }));
    if (connectableCache !== undefined && Date.now() - connectableCache.at < CONNECTABLE_CACHE_TTL_MS) {
      return connectableCache.entries;
    }

    // auth_configs paginates by PAGE NUMBER, not cursor: live-probed
    // 2026-07-20, the API clamps limit to 50 and answers `total_pages: 1,
    // next_cursor: null` even when total_items is larger — cursor-following
    // silently drops the tail. Walk `cursor=1,2,…` until the item count
    // reaches total_items.
    const toolkits = new Set<string>();
    let itemsSeen = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await composioFetch(`${ACCOUNTS_BASE}/auth_configs`, {
        query: { limit: "100", cursor: String(page) },
      });
      if (!response.ok) {
        const { message } = responseErrorParts(response.payload);
        throw new Error(`Composio auth-configs request failed with ${response.status}: ${message ?? ""}`.trim());
      }
      const parsed = pageParts(response.payload as ComposioPage);
      for (const item of parsed.items as Array<{ status?: unknown; toolkit?: { slug?: unknown } }>) {
        // The same enablement test initiate applies (anything not DISABLED).
        if (item.status === "DISABLED") continue;
        if (typeof item.toolkit?.slug === "string") toolkits.add(item.toolkit.slug);
      }
      itemsSeen += parsed.items.length;
      const totalItems = (response.payload as { total_items?: unknown }).total_items;
      const done = parsed.items.length === 0
        || typeof totalItems !== "number"
        || itemsSeen >= totalItems;
      if (done) {
        const entries = [...toolkits].map((toolkit) => ({ toolkit }));
        connectableCache = { at: Date.now(), entries };
        return entries;
      }
    }

    throw new Error(`Composio auth-configs pagination exceeded ${MAX_PAGES} pages`);
  }

  /** The one execution path, shared by the listed-tool call and the
   * `use_service_tool` dispatch: both are the same Composio call as the same
   * person, so both must produce the same outcomes — including the typed
   * connect-required the connect card renders — and the same audit enrichment. */
  async function runTool(slug: string, toolkit: string, args: unknown, ctx: RunContext): Promise<ToolOutcome> {
    const entityId = config.entityId?.(ctx) ?? ctx.principal.subject;
    const identity: ConnectorAccountIdentity = { connector: "composio", toolkit, entityId };
    try {
      const response = await composioFetch(`${TOOLS_BASE}/tools/execute/${encodeURIComponent(slug)}`, {
        method: "POST",
        body: { user_id: entityId, arguments: args },
      });
      const payload = response.payload as { successful?: unknown; data?: unknown };
      if (!response.ok || payload.successful !== true) {
        const { message, slug: errorSlug } = responseErrorParts(response.payload);
        // A missing per-user connection is a typed outcome, not an opaque
        // error: the UI renders an inline connect card and retries after
        // the user connects (04-actions §3).
        if (errorSlug === NO_CONNECTED_ACCOUNT_SLUG) {
          return withIdentity({
            status: "connect-required",
            connect: {
              connector: "composio",
              toolkit,
              message: `Connect your ${toolkit} account to run ${slug}.`,
            },
          }, identity);
        }
        return withIdentity(errorOutcome(message ?? `Composio execution failed with ${response.status}`), identity);
      }
      return withIdentity({ status: "ok", output: payload.data as never }, identity);
    } catch (error) {
      return withIdentity(
        errorOutcome(error instanceof Error ? error.message : "Composio execution failed"),
        identity,
      );
    }
  }

  return {
    name: "composio",

    // Feeds the pre-guard connect check: every Composio tool runs on a
    // per-user connected account.
    toolkitOf: (tool) => normalizedToRaw.get(tool)?.toolkit,

    /** Composio's own search, which is the whole point: a host cannot index
     * 20,000 third-party tools, and their planner already does. Each row comes
     * back complete — slug, schema, connect status — so the model can call it
     * without a second lookup and the tool LISTING never has to change. */
    async searchTools(need: string, ctx: RunContext): Promise<ServiceToolMatch[]> {
      const subject = config.entityId?.(ctx) ?? ctx.principal.subject;
      const session = await sessionFor(subject);
      const response = await composioFetch(
        `${TOOLS_BASE}/tool_router/session/${encodeURIComponent(session)}/search`,
        // `use_case` is their field for an intent phrase. `known_fields` is a
        // "key:value, …" STRING, not an object, and we have nothing to put in
        // it — the model's arguments are not known until it has the schema.
        { method: "POST", body: { queries: [{ use_case: need }] } },
      );
      if (!response.ok) {
        const { message } = responseErrorParts(response.payload);
        throw new Error(`Composio search failed with ${response.status}: ${message ?? ""}`.trim());
      }
      const payload = response.payload as ComposioSearchResponse;

      // Primary hits first, related ones only to fill: their search takes no
      // limit parameter, so the ordering IS the relevance signal we have.
      const slugs: string[] = [];
      for (const key of ["primary_tool_slugs", "related_tool_slugs"] as const) {
        for (const result of payload.results ?? []) {
          for (const slug of Array.isArray(result[key]) ? (result[key] as unknown[]) : []) {
            if (typeof slug === "string" && !slugs.includes(slug)) slugs.push(slug);
          }
        }
      }
      const matched = slugs.slice(0, MAX_MATCHES);

      // Their search answers with slugs; schemas ride in a separate map that is
      // documented as populated only "when a full schema is available", and the
      // risk tags are not in the search answer at all. One batch read closes
      // both gaps, so a row is never half a row.
      await loadTools(matched);

      const status = new Map<string, { connected: boolean; message?: string }>();
      for (const entry of payload.toolkit_connection_statuses ?? []) {
        if (typeof entry.toolkit !== "string") continue;
        status.set(entry.toolkit, {
          connected: entry.has_active_connection === true,
          ...(typeof entry.status_message === "string" && entry.status_message
            ? { message: entry.status_message }
            : {}),
        });
      }

      const matches: ServiceToolMatch[] = [];
      for (const slug of matched) {
        const details = slugCache.get(slug);
        if (details === undefined) continue;
        const connection = status.get(details.toolkit);
        matches.push({
          slug,
          toolkit: details.toolkit,
          description: details.description,
          ...(details.inputSchema === undefined ? {} : { inputSchema: details.inputSchema }),
          connected: connection?.connected === true,
          ...(connection?.message === undefined ? {} : { statusMessage: connection.message }),
        });
      }
      return matches;
    },

    /** UPSTREAM FACTS ONLY. `undefined` is reserved for "Composio does not have
     * this slug"; a slug that exists with no usable tag grades `ungraded`, which
     * the guard asks about until a judge or a person says otherwise. */
    async toolRisk(slug: string): Promise<RiskLabel | undefined> {
      const details = await toolDetails(slug);
      return details === undefined ? undefined : composioToolRisk(details.tags);
    },

    async executeSlug(slug: string, args: unknown, ctx: RunContext): Promise<ToolOutcome> {
      const details = await toolDetails(slug);
      if (details === undefined) {
        return { status: "error", error: { code: "not-found", message: `Unknown Composio tool: ${slug}` } };
      }
      return runTool(slug, details.toolkit, args, ctx);
    },

    async descriptors(): Promise<ToolDescriptor[]> {
      // Built fresh and swapped in atomically so a concurrent execute() never sees a half-empty map.
      const nextNormalizedToRaw = new Map<string, { raw: string; toolkit: string }>();
      // Only an `apps`-scoped connector puts tools on the LISTING. Unscoped, the
      // catalog is 20,000 tools and belongs behind `use_service_tool` instead —
      // which reaches every one of them without the listing ever growing.
      const appFilters = config.apps;
      if (appFilters === undefined || appFilters.length === 0) {
        normalizedToRaw = nextNormalizedToRaw;
        return [];
      }
      const pages = await Promise.all(appFilters.map((app) => toolkitTools(app)));
      const descriptors: ToolDescriptor[] = [];

      for (const item of pages.flat()) {
        const raw = typeof item.slug === "string" ? item.slug : typeof item.name === "string" ? item.name : undefined;
        const toolkit =
          typeof item.toolkit_slug === "string"
            ? item.toolkit_slug
            : typeof item.toolkit?.slug === "string"
              ? item.toolkit.slug
              : undefined;
        if (!raw || !toolkit) throw new Error("Composio tool is missing its slug or toolkit slug");
        const name = normalizeToolName(toolkit, raw);
        if (nextNormalizedToRaw.has(name)) throw new Error(`Composio tool-name collision: ${name}`);
        nextNormalizedToRaw.set(name, { raw, toolkit });
        const tags = Array.isArray(item.tags)
          ? (item.tags as unknown[]).filter((tag): tag is string => typeof tag === "string")
          : undefined;
        descriptors.push({
          name,
          // The connectable toolkit gating this tool's usefulness (01-core §4
          // `ToolDescriptor.toolkit`): downstream seams skip work for
          // unconnected toolkits (the apps runtime's create-time shape probes).
          toolkit,
          description: typeof item.description === "string" ? item.description : raw,
          inputSchema:
            item.input_parameters && typeof item.input_parameters === "object" && !Array.isArray(item.input_parameters)
              ? (item.input_parameters as Record<string, unknown>)
              : {},
          // 04-actions §3: upstream hints only — an untagged tool is ungraded.
          risk: composioToolRisk(tags),
        });
      }

      normalizedToRaw = nextNormalizedToRaw;
      return descriptors;
    },

    execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const entry = normalizedToRaw.get(call.tool);
      if (!entry) {
        return Promise.resolve({
          status: "error",
          error: { code: "not-found", message: `Unknown Composio tool: ${call.tool}` },
        });
      }
      return runTool(entry.raw, entry.toolkit, call.args, ctx);
    },

    connections: {
      list: (subject) => listAccounts(subject),
      listConnectable,

      async initiate(subject, toolkit, options) {
        const configs = await composioFetch(`${ACCOUNTS_BASE}/auth_configs`, { query: { toolkit_slug: toolkit } });
        if (!configs.ok) {
          const { message } = responseErrorParts(configs.payload);
          throw new Error(`Composio auth-config lookup failed with ${configs.status}: ${message ?? ""}`.trim());
        }
        const items = pageParts(configs.payload as ComposioPage).items as Array<{ id?: unknown; status?: unknown }>;
        const enabled = items.find((item) => typeof item.id === "string" && item.status !== "DISABLED");
        if (!enabled) {
          throw new VendoError(
            "not-implemented",
            `No Composio auth config exists for toolkit ${toolkit}; create one in the Composio dashboard first.`,
          );
        }
        const linked = await composioFetch(`${ACCOUNTS_BASE}/connected_accounts/link`, {
          method: "POST",
          body: {
            auth_config_id: enabled.id,
            user_id: subject,
            ...(options?.callbackUrl === undefined ? {} : { callback_url: options.callbackUrl }),
          },
        });
        if (!linked.ok) {
          const { message } = responseErrorParts(linked.payload);
          throw new Error(`Composio connect initiation failed with ${linked.status}: ${message ?? ""}`.trim());
        }
        const payload = linked.payload as { redirect_url?: unknown; connected_account_id?: unknown };
        if (typeof payload.redirect_url !== "string" || typeof payload.connected_account_id !== "string") {
          throw new Error("Composio connect initiation returned no redirect URL");
        }
        return { id: payload.connected_account_id, redirectUrl: payload.redirect_url };
      },

      async status(subject, connectionId) {
        const accounts = await listAccounts(subject, connectionId);
        return accounts.find((account) => account.id === connectionId) ?? null;
      },

      async disconnect(subject, connectionId) {
        // Ownership check BEFORE any delete: an id outside the subject's own
        // user_ids scope reads as absent, so no cross-principal delete can
        // ever leave this process.
        const owned = await listAccounts(subject, connectionId);
        if (!owned.some((account) => account.id === connectionId)) {
          throw new VendoError("not-found", `connection not found: ${connectionId}`);
        }
        const response = await composioFetch(`${ACCOUNTS_BASE}/connected_accounts/${encodeURIComponent(connectionId)}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          const { message } = responseErrorParts(response.payload);
          throw new Error(`Composio disconnect failed with ${response.status}: ${message ?? ""}`.trim());
        }
      },
    },
  };
}
