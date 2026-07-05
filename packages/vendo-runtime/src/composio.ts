/**
 * Per-user Composio tool ingestion for the Vendo agent runtime.
 *
 * Composio brokers external SaaS tools (Gmail, Slack, …) with managed per-user
 * OAuth and hands them back as Vercel `ai`-SDK tools. The rest of the engine
 * must never depend on Composio's concrete API, so this module exposes a tiny
 * `ComposioClient` seam: the real adapter (`createComposioClient`) wraps
 * `@composio/core` + `@composio/vercel`, while tests inject a fake.
 *
 * Ingestion FAILS CLOSED: a tool is only fetched when there is both an explicit
 * user and an explicit allowlist (toolkits and/or specific tool slugs). Broad
 * implicit discovery is a footgun and is never performed.
 */

import type { ToolSet } from "ai";
import { capToolOutput } from "@vendoai/core";
import type { VendoPrincipal } from "./principal.js";
import { buildDescriptor, type ToolDescriptor } from "./descriptor.js";

/**
 * Configuration for Composio ingestion. The allowlist (`toolkits`/`tools`) is
 * mandatory in spirit: if both are empty, nothing is fetched.
 */
export interface ComposioConfig {
  /** Composio API key. Falls back to `COMPOSIO_API_KEY` in the real adapter. */
  apiKey?: string;
  /** Allowlisted toolkit slugs, e.g. `["gmail", "slack"]`. */
  toolkits?: string[];
  /** Allowlisted individual tool slugs, e.g. `["GMAIL_SEND_EMAIL"]`. */
  tools?: string[];
}

/**
 * The Vendo abstraction over Composio. This is the injectable seam: the real
 * implementation wraps `@composio/*`; tests implement it directly.
 */
export interface ComposioClient {
  fetchTools(
    userId: string,
    allowlist: { toolkits?: string[]; tools?: string[] },
  ): Promise<ToolSet>;

  /**
   * Kick off (or resume) a per-user OAuth connection for a toolkit. Returns the
   * real provider OAuth `redirectUrl` to open in a popup, plus the
   * `connectedAccountId` to poll. When the user is already authorized the SDK may
   * return a `null` redirectUrl and an already-ACTIVE account (fast path).
   */
  authorize(
    userId: string,
    toolkit: string,
  ): Promise<{ redirectUrl: string | null; connectedAccountId: string }>;

  /**
   * Normalized status of a connected account: `"active"` once the OAuth flow has
   * completed, `"pending"` while it is still in flight, `"failed"` for any
   * terminal non-active state (failed/expired/inactive).
   */
  connectionStatus(
    connectedAccountId: string,
  ): Promise<"active" | "pending" | "failed">;

  /**
   * True only if the user has an ACTIVE connected account for the toolkit. This
   * is the authoritative "is it connected" check — unlike fetchTools, which can
   * return a toolkit's tool schemas even when the user hasn't authorized it.
   */
  hasActiveConnection(userId: string, toolkit: string): Promise<boolean>;
}

/**
 * Normalize a raw Composio `ConnectedAccountStatus`
 * (INITIALIZING | INITIATED | ACTIVE | FAILED | EXPIRED | INACTIVE) down to the
 * three states the Vendo connect flow cares about.
 */
function normalizeConnectionStatus(
  raw: string | undefined,
): "active" | "pending" | "failed" {
  const status = (raw ?? "").toUpperCase();
  if (status === "ACTIVE") return "active";
  if (status === "INITIALIZING" || status === "INITIATED") return "pending";
  return "failed";
}

/**
 * Build the REAL Composio adapter for `@composio/core@0.4.0` +
 * `@composio/vercel@0.4.0`.
 *
 * The 0.4.0 API:
 *   - `new Composio({ apiKey, provider: new VercelProvider() })`
 *   - `await composio.tools.get(userId, filters)` where `filters` is a
 *     `ToolListParams` — a STRICT union that accepts EITHER `{ toolkits }` OR
 *     `{ tools }`, never both. With the Vercel provider the result is already a
 *     Vercel `ai`-SDK `ToolSet`.
 *
 * Because `toolkits` and `tools` are mutually exclusive in a single `get`
 * call, the adapter issues one call per non-empty allowlist dimension and
 * merges the results.
 *
 * Construction is lazy: the underlying Composio client is built on first fetch,
 * so constructing the adapter never touches the network.
 */
export function createComposioClient(config: ComposioConfig): ComposioClient {
  type ComposioCtor = new (cfg: {
    apiKey?: string;
    provider?: unknown;
  }) => {
    tools: {
      get(userId: string, filters: unknown): Promise<ToolSet>;
    };
    toolkits: {
      authorize(
        userId: string,
        toolkitSlug: string,
      ): Promise<{ id: string; redirectUrl?: string | null }>;
    };
    connectedAccounts: {
      get(connectedAccountId: string): Promise<{ status?: string }>;
      list(query: {
        userIds?: string[];
        toolkitSlugs?: string[];
        statuses?: string[];
      }): Promise<{ items?: Array<{ status?: string }> }>;
    };
  };

  // Lazily-constructed singleton so we never connect at construction time.
  let composio: InstanceType<ComposioCtor> | undefined;

  async function getComposio(): Promise<InstanceType<ComposioCtor>> {
    if (composio) return composio;
    const [{ Composio }, { VercelProvider }] = await Promise.all([
      import("@composio/core"),
      import("@composio/vercel"),
    ]);
    composio = new (Composio as unknown as ComposioCtor)({
      // Fall back to the standard env var when no explicit key was given. Read
      // lazily here (at first fetch), never at module load.
      apiKey: config.apiKey ?? process.env.COMPOSIO_API_KEY,
      provider: new VercelProvider(),
    });
    return composio;
  }

  return {
    async fetchTools(userId, allowlist) {
      const client = await getComposio();
      const merged: ToolSet = {};

      if (allowlist.tools && allowlist.tools.length > 0) {
        const byTool = await client.tools.get(userId, { tools: allowlist.tools });
        Object.assign(merged, byTool);
      }
      if (allowlist.toolkits && allowlist.toolkits.length > 0) {
        // Fetch per-toolkit and tolerate failures: a toolkit the user hasn't
        // connected (or a bad slug) must NOT wipe out the toolkits they have.
        const perToolkit = await Promise.all(
          allowlist.toolkits.map(async (toolkit) => {
            try {
              return await client.tools.get(userId, { toolkits: [toolkit] });
            } catch {
              return {} as ToolSet;
            }
          }),
        );
        for (const set of perToolkit) Object.assign(merged, set);
      }
      return merged;
    },

    async hasActiveConnection(userId, toolkit) {
      const client = await getComposio();
      try {
        const res = await client.connectedAccounts.list({
          userIds: [userId],
          toolkitSlugs: [toolkit],
          statuses: ["ACTIVE"],
        });
        return (res.items ?? []).length > 0;
      } catch {
        return false;
      }
    },

    async authorize(userId, toolkit) {
      const client = await getComposio();
      const request = await client.toolkits.authorize(userId, toolkit);
      return {
        redirectUrl: request.redirectUrl ?? null,
        connectedAccountId: request.id,
      };
    },

    async connectionStatus(connectedAccountId) {
      const client = await getComposio();
      const account = await client.connectedAccounts.get(connectedAccountId);
      return normalizeConnectionStatus(account.status);
    },
  };
}

/**
 * Ingest per-user Composio tools behind the Vendo seam.
 *
 * FAILS CLOSED: returns empty WITHOUT calling the client when the principal has
 * no `userId`, or when the allowlist is entirely empty. Otherwise fetches the
 * allowlisted tools and produces a `ToolDescriptor` (`source: "composio"`) for
 * each returned tool.
 */
export async function ingestComposioTools(args: {
  principal: VendoPrincipal;
  config: ComposioConfig;
  client: ComposioClient;
}): Promise<{ toolset: ToolSet; descriptors: ToolDescriptor[] }> {
  const { principal, config, client } = args;

  const hasUser = typeof principal.userId === "string" && principal.userId.length > 0;
  const hasAllowlist =
    (config.toolkits?.length ?? 0) > 0 || (config.tools?.length ?? 0) > 0;

  if (!hasUser || !hasAllowlist) {
    return { toolset: {}, descriptors: [] };
  }

  const toolset = await client.fetchTools(principal.userId, {
    toolkits: config.toolkits,
    tools: config.tools,
  });

  // Ingestion is a capping point (context-engineering spec §5): external tool
  // results (full Gmail bodies, base64 attachments) are shrunk deterministically
  // and shape-stably before they ever reach the model context.
  for (const tool of Object.values(toolset)) {
    const original = tool.execute;
    if (typeof original !== "function") continue;
    const bound = original.bind(tool);
    tool.execute = async (input, options) =>
      capToolOutput(await bound(input, options), CHAT_TOOL_OUTPUT_BUDGET).result;
  }

  const descriptors = Object.entries(toolset).map(([name, tool]) =>
    buildDescriptor(name, tool, "composio"),
  );

  return { toolset, descriptors };
}

/** Chat-side budget: server context is cheap relative to realtime voice, but
 *  a raw Gmail body still costs real tokens — cap generously, not infinitely. */
const CHAT_TOOL_OUTPUT_BUDGET = { maxChars: 16_000, attachNote: true } as const;
