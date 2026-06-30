/**
 * Per-user Composio tool ingestion for the Flowlet agent runtime.
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
import type { FlowletPrincipal } from "./principal";
import { buildDescriptor, type ToolDescriptor } from "./descriptor";

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
 * The Flowlet abstraction over Composio. This is the injectable seam: the real
 * implementation wraps `@composio/*`; tests implement it directly.
 */
export interface ComposioClient {
  fetchTools(
    userId: string,
    allowlist: { toolkits?: string[]; tools?: string[] },
  ): Promise<ToolSet>;
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
  };
}

/**
 * Ingest per-user Composio tools behind the Flowlet seam.
 *
 * FAILS CLOSED: returns empty WITHOUT calling the client when the principal has
 * no `userId`, or when the allowlist is entirely empty. Otherwise fetches the
 * allowlisted tools and produces a `ToolDescriptor` (`source: "composio"`) for
 * each returned tool.
 */
export async function ingestComposioTools(args: {
  principal: FlowletPrincipal;
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

  const descriptors = Object.entries(toolset).map(([name, tool]) =>
    buildDescriptor(name, tool, "composio"),
  );

  return { toolset, descriptors };
}
