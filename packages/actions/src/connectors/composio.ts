import { VendoError, type RunContext, type ToolCall, type ToolDescriptor, type ToolOutcome } from "@vendoai/core";
import type { Connector, ConnectorAccount, ConnectorAccountIdentity } from "./connector.js";
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

interface ComposioConnectedAccount {
  id?: unknown;
  toolkit?: { slug?: unknown };
  status?: unknown;
  created_at?: unknown;
}

const MAX_PAGES = 50;

/** Composio's deterministic missing-connection signal on tool execution. */
const NO_CONNECTED_ACCOUNT_SLUG = "ActionExecute_ConnectedAccountNotFound";

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
  const baseUrl = (config.baseUrl ?? "https://backend.composio.dev").replace(/\/$/, "");
  let normalizedToRaw = new Map<string, { raw: string; toolkit: string }>();

  async function composioFetch(
    path: string,
    options: { method?: string; query?: Record<string, string>; body?: Record<string, unknown> } = {},
  ): Promise<{ ok: boolean; status: number; payload: unknown }> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
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

  async function fetchTools(app?: string): Promise<ComposioTool[]> {
    const tools: ComposioTool[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await composioFetch("/api/v3/tools", {
        query: {
          ...(app === undefined ? {} : { toolkit_slug: app }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      if (!response.ok) {
        const { message } = responseErrorParts(response.payload);
        throw new Error(`Composio tools request failed with ${response.status}: ${message ?? ""}`.trim());
      }
      const parsed = pageParts(response.payload as ComposioPage);
      tools.push(...(parsed.items as ComposioTool[]));
      cursor = parsed.nextCursor;
      if (!cursor) return tools;
      if (seenCursors.has(cursor)) throw new Error(`Composio pagination loop at cursor ${cursor}`);
      seenCursors.add(cursor);
    }

    throw new Error(`Composio tools pagination exceeded ${MAX_PAGES} pages`);
  }

  /** Connected accounts scoped to ONE subject. Every Composio read filters by
   * user_ids=subject so one principal can never observe another's accounts. */
  async function listAccounts(subject: string, connectedAccountId?: string): Promise<ConnectorAccount[]> {
    const accounts: ConnectorAccount[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await composioFetch("/api/v3/connected_accounts", {
        query: {
          user_ids: subject,
          ...(connectedAccountId === undefined ? {} : { connected_account_ids: connectedAccountId }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      if (!response.ok) {
        const { message } = responseErrorParts(response.payload);
        throw new Error(`Composio connected-accounts request failed with ${response.status}: ${message ?? ""}`.trim());
      }
      const parsed = pageParts(response.payload as ComposioPage);
      for (const item of parsed.items as ComposioConnectedAccount[]) {
        if (typeof item.id !== "string" || typeof item.toolkit?.slug !== "string") continue;
        accounts.push({
          id: item.id,
          connector: "composio",
          toolkit: item.toolkit.slug,
          status: accountStatus(item.status),
          ...(typeof item.created_at === "string" ? { createdAt: item.created_at } : {}),
        });
      }
      cursor = parsed.nextCursor;
      if (!cursor) return accounts;
      if (seenCursors.has(cursor)) throw new Error(`Composio pagination loop at cursor ${cursor}`);
      seenCursors.add(cursor);
    }

    throw new Error(`Composio connected-accounts pagination exceeded ${MAX_PAGES} pages`);
  }

  return {
    name: "composio",

    async descriptors(): Promise<ToolDescriptor[]> {
      // Built fresh and swapped in atomically so a concurrent execute() never sees a half-empty map.
      const nextNormalizedToRaw = new Map<string, { raw: string; toolkit: string }>();
      const appFilters = config.apps === undefined ? [undefined] : config.apps;
      const pages = await Promise.all(appFilters.map((app) => fetchTools(app)));
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
          description: typeof item.description === "string" ? item.description : raw,
          inputSchema:
            item.input_parameters && typeof item.input_parameters === "object" && !Array.isArray(item.input_parameters)
              ? (item.input_parameters as Record<string, unknown>)
              : {},
          // 04-actions §3: curated risk (metadata hints + slug patterns,
          // conservative write default) replaces the old hardcoded "write".
          risk: composioToolRisk(raw, toolkit, tags),
        });
      }

      normalizedToRaw = nextNormalizedToRaw;
      return descriptors;
    },

    async execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const entry = normalizedToRaw.get(call.tool);
      if (!entry) {
        return { status: "error", error: { code: "not-found", message: `Unknown Composio tool: ${call.tool}` } };
      }

      const entityId = config.entityId?.(ctx) ?? ctx.principal.subject;
      const identity: ConnectorAccountIdentity = { connector: "composio", toolkit: entry.toolkit, entityId };
      try {
        const response = await composioFetch(`/api/v3/tools/execute/${encodeURIComponent(entry.raw)}`, {
          method: "POST",
          body: { user_id: entityId, arguments: call.args },
        });
        const payload = response.payload as { successful?: unknown; data?: unknown };
        if (!response.ok || payload.successful !== true) {
          const { message, slug } = responseErrorParts(response.payload);
          // A missing per-user connection is a typed outcome, not an opaque
          // error: the UI renders an inline connect card and retries after
          // the user connects (04-actions §3).
          if (slug === NO_CONNECTED_ACCOUNT_SLUG) {
            return withIdentity({
              status: "connect-required",
              connect: {
                connector: "composio",
                toolkit: entry.toolkit,
                message: `Connect your ${entry.toolkit} account to run ${call.tool}.`,
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
    },

    connections: {
      list: (subject) => listAccounts(subject),

      async initiate(subject, toolkit, options) {
        const configs = await composioFetch("/api/v3/auth_configs", { query: { toolkit_slug: toolkit } });
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
        const linked = await composioFetch("/api/v3/connected_accounts/link", {
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
        const response = await composioFetch(`/api/v3/connected_accounts/${encodeURIComponent(connectionId)}`, {
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
