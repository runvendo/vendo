import { composioToolRisk, normalizeToolName, type Connector, type ConnectorAccountIdentity } from "@vendoai/actions";
import type { RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";
import { deploymentIdentityHeaders } from "./deployment-identity.js";
import { defaultFetch } from "@vendoai/core";

/** The Cloud tools adapter — the execution half of the zero-key Composio
 * seam (cloudConnections is the account half). Tools list and execute ride
 * the console's broker (`GET /api/v1/tools`, `POST /api/v1/tools/execute`),
 * which holds Vendo's Composio credentials and namespaces every call by the
 * caller's org; this connector never sees a Composio key.
 *
 * The connector is named "composio" on purpose: connect-required outcomes,
 * the connect dock's catalog rows, and connection initiation all carry the
 * same connector name, so the whole connect-then-use loop stays one broker
 * from the UI's point of view. */
export interface CloudToolsOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  /** Toolkit scoping, same meaning as composioConnector's `apps`. Unset =
   * everything the console's catalog advertises (enabled auth configs).
   * When set, pass the SAME list to cloudConnections({ apps }) so the
   * connect dock's catalog stays in lockstep with the executable tools. */
  apps?: string[];
  fetch?: typeof fetch;
}

type WireTool = {
  slug?: unknown;
  toolkit?: unknown;
  description?: unknown;
  inputParameters?: unknown;
  tags?: unknown;
};

function errorOutcome(message: string): ToolOutcome {
  return { status: "error", error: { code: "connector-error", message } };
}

function withIdentity(outcome: ToolOutcome, identity: ConnectorAccountIdentity): ToolOutcome {
  return Object.assign({}, outcome, { connectorAccount: identity });
}

export function cloudTools(options: CloudToolsOptions): Connector {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? defaultFetch;
  let normalizedToRaw = new Map<string, { raw: string; toolkit: string }>();

  async function cloudFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; payload: unknown }> {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        ...(await deploymentIdentityHeaders()),
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch {
      // Non-JSON bodies fall through to the caller's status handling.
    }
    return { ok: response.ok, status: response.status, payload };
  }

  // Connection-scoped tool loading (spec 2026-07-20): without explicit `apps`
  // the connector is LAZY — nothing fetches eagerly; discovery rides the
  // console catalog and schemas load per toolkit on expansion.
  const lazy = options.apps === undefined;
  const expandedToolkits = new Set<string>();
  const toolkitToolCache = new Map<string, Promise<WireTool[]>>();
  let indexPromise: Promise<Array<{ toolkit: string; label?: string; description?: string }>> | undefined;

  /** One toolkits= fetch, degrade-never-throw (a failed toolkit just loads
   * nothing this round; the memo is dropped so a later read retries). */
  function fetchToolkitTools(toolkits: string): Promise<WireTool[]> {
    let promise = toolkitToolCache.get(toolkits);
    if (!promise) {
      promise = (async () => {
        let response: { ok: boolean; status: number; payload: unknown };
        try {
          response = await cloudFetch(`/api/v1/tools?toolkits=${encodeURIComponent(toolkits)}`);
        } catch (error) {
          toolkitToolCache.delete(toolkits);
          console.warn("[vendo] Vendo Cloud tools broker unreachable; no connector tools loaded:", error instanceof Error ? error.message : error);
          return [];
        }
        if (!response.ok) {
          toolkitToolCache.delete(toolkits);
          const message = (response.payload as { error?: { message?: unknown } }).error?.message;
          console.warn(
            `[vendo] Vendo Cloud tools broker returned ${response.status}; no connector tools loaded${typeof message === "string" && message ? `: ${message}` : "."}`,
          );
          return [];
        }
        const items = response.payload && typeof response.payload === "object"
          ? (response.payload as { tools?: unknown }).tools
          : undefined;
        return (Array.isArray(items) ? items : []) as WireTool[];
      })();
      toolkitToolCache.set(toolkits, promise);
    }
    return promise;
  }

  async function buildIndex(): Promise<Array<{ toolkit: string; label?: string; description?: string }>> {
    let response: { ok: boolean; status: number; payload: unknown };
    try {
      response = await cloudFetch("/api/v1/connections/catalog");
    } catch (error) {
      indexPromise = undefined;
      console.warn("[vendo] Vendo Cloud catalog unreachable; connector discovery is empty:", error instanceof Error ? error.message : error);
      return [];
    }
    if (!response.ok) {
      indexPromise = undefined;
      console.warn(`[vendo] Vendo Cloud catalog returned ${response.status}; connector discovery is empty.`);
      return [];
    }
    const available = response.payload && typeof response.payload === "object"
      ? (response.payload as { available?: unknown }).available
      : undefined;
    if (!Array.isArray(available)) return [];
    return available
      .filter((entry): entry is { toolkit: string; label?: string; description?: string } =>
        !!entry && typeof entry === "object" && typeof (entry as { toolkit?: unknown }).toolkit === "string")
      .map((entry) => ({
        toolkit: entry.toolkit,
        ...(typeof entry.label === "string" ? { label: entry.label } : {}),
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      }));
  }

  return {
    name: "composio",

    discoveryIndex: () => (indexPromise ??= buildIndex()),

    async expandToolkits(toolkits: string[]): Promise<boolean> {
      if (!lazy) return false;
      const connectable = new Set((await (indexPromise ??= buildIndex())).map((entry) => entry.toolkit));
      let changed = false;
      for (const toolkit of toolkits) {
        if (!connectable.has(toolkit) || expandedToolkits.has(toolkit)) continue;
        expandedToolkits.add(toolkit);
        changed = true;
      }
      return changed;
    },

    async descriptors(): Promise<ToolDescriptor[]> {
      // The auto-composed cloud default must never brick the host: a thrown
      // descriptors() fails the ENTIRE registry load, host tools included.
      // Every fetch below degrades to "no connector tools" with one warn.
      let items: WireTool[];
      if (lazy) {
        if (expandedToolkits.size === 0) {
          normalizedToRaw = new Map();
          return [];
        }
        const lists = await Promise.all([...expandedToolkits].map((toolkit) => fetchToolkitTools(toolkit)));
        items = lists.flat();
      } else {
        items = await fetchToolkitTools(options.apps!.join(","));
      }
      const nextNormalizedToRaw = new Map<string, { raw: string; toolkit: string }>();
      const descriptors: ToolDescriptor[] = [];
      for (const item of items) {
        if (typeof item.slug !== "string" || typeof item.toolkit !== "string") continue;
        const name = normalizeToolName(item.toolkit, item.slug);
        if (nextNormalizedToRaw.has(name)) throw new Error(`Cloud tools name collision: ${name}`);
        nextNormalizedToRaw.set(name, { raw: item.slug, toolkit: item.toolkit });
        const tags = Array.isArray(item.tags)
          ? (item.tags as unknown[]).filter((tag): tag is string => typeof tag === "string")
          : undefined;
        descriptors.push({
          name,
          description: typeof item.description === "string" ? item.description : item.slug,
          inputSchema:
            item.inputParameters && typeof item.inputParameters === "object" && !Array.isArray(item.inputParameters)
              ? (item.inputParameters as Record<string, unknown>)
              : {},
          // The same curated risk labels BYO Composio tools get — the guard
          // and approval cards behave identically across postures.
          risk: composioToolRisk(item.slug, item.toolkit, tags),
        });
      }
      // Swapped atomically so a concurrent execute() never sees a half map.
      normalizedToRaw = nextNormalizedToRaw;
      return descriptors;
    },

    async execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const entry = normalizedToRaw.get(call.tool);
      if (!entry) {
        return { status: "error", error: { code: "not-found", message: `Unknown cloud tool: ${call.tool}` } };
      }
      const subject = ctx.principal.subject;
      const identity: ConnectorAccountIdentity = {
        connector: "composio",
        toolkit: entry.toolkit,
        entityId: subject,
        credential: "per-principal",
      };
      try {
        const response = await cloudFetch("/api/v1/tools/execute", {
          method: "POST",
          body: JSON.stringify({
            subject,
            toolkit: entry.toolkit,
            tool: entry.raw,
            arguments: call.args,
          }),
        });
        if (!response.ok) {
          const message = (response.payload as { error?: { message?: unknown } }).error?.message;
          return withIdentity(
            errorOutcome(
              typeof message === "string" && message
                ? message
                : `Vendo Cloud tool execution failed with ${response.status}`,
            ),
            identity,
          );
        }
        const outcome = (response.payload as { outcome?: unknown }).outcome;
        if (!outcome || typeof outcome !== "object") {
          return withIdentity(errorOutcome("Vendo Cloud tool execution returned no outcome"), identity);
        }
        return withIdentity(outcome as ToolOutcome, identity);
      } catch (error) {
        return withIdentity(
          errorOutcome(error instanceof Error ? error.message : "Vendo Cloud tool execution failed"),
          identity,
        );
      }
    },
  };
}
