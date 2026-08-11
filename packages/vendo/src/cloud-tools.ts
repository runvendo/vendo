import { composioToolRisk, normalizeToolName, type Connector, type ConnectorAccountIdentity } from "@vendoai/actions";
import type { RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";
import { deploymentIdentityHeaders } from "./deployment-identity.js";
import { debugConnectorHttp, defaultFetch, log } from "@vendoai/core";

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
  /** Toolkit scoping, same meaning as composioConnector's `apps`. Unset = this
   * connector registers NO tools at all: the console's catalog is far too large
   * to mount on a listing, so the long tail is reached through the service-tool
   * pair instead. When set, pass the SAME list to cloudConnections({ apps }) so
   * the connect dock's catalog stays in lockstep with the executable tools. */
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
    debugConnectorHttp("cloud-tools", init?.method ?? "GET", path);
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

  const toolkitToolCache = new Map<string, Promise<WireTool[]>>();

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
          log({
            code: "vendo.cloud-tools-unreachable",
            level: "warn",
            message: "[vendo] Vendo Cloud tools broker unreachable; no connector tools loaded:",
            data: { error: error instanceof Error ? error.message : error },
          });
          return [];
        }
        if (!response.ok) {
          toolkitToolCache.delete(toolkits);
          const message = (response.payload as { error?: { message?: unknown } }).error?.message;
          log({
            code: "vendo.cloud-tools-broker-error",
            level: "warn",
            message:
              `[vendo] Vendo Cloud tools broker returned ${response.status}; no connector tools loaded${typeof message === "string" && message ? `: ${message}` : "."}`,
          });
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

  return {
    name: "composio",

    // Feeds the pre-guard connect check: every brokered tool runs on a
    // per-user connected account (same semantics as BYO composioConnector).
    toolkitOf: (tool) => normalizedToRaw.get(tool)?.toolkit,

    async descriptors(): Promise<ToolDescriptor[]> {
      // Registry tools exist only for an explicitly scoped deployment. UNSCOPED
      // (`apps` unset) this connector registers NOTHING: the console's catalog
      // is tens of thousands of tools, and the whole point of the service-tool
      // pair is that the long tail is reached through Composio's own search
      // rather than mounted on the listing.
      if (options.apps === undefined) {
        normalizedToRaw = new Map();
        return [];
      }
      // The auto-composed cloud default must never brick the host: a thrown
      // descriptors() fails the ENTIRE registry load, host tools included.
      // The fetch below degrades to "no connector tools" with one warn.
      const items = await fetchToolkitTools([...new Set(options.apps)].join(","));
      const nextNormalizedToRaw = new Map<string, { raw: string; toolkit: string }>();
      const descriptors: ToolDescriptor[] = [];
      for (const item of items) {
        if (typeof item.slug !== "string" || typeof item.toolkit !== "string") continue;
        const name = normalizeToolName(item.toolkit, item.slug);
        // Degrade, do not throw: the console repeating a slug must not delete
        // the host's own tools. First one wins so the list stays stable.
        if (nextNormalizedToRaw.has(name)) {
          log({
            code: "vendo.cloud-tools-duplicate-tool",
            level: "warn",
            message: `[vendo] Cloud tools: skipping duplicate tool name ${name}`,
          });
          continue;
        }
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
          // The same upstream-hint risk labels BYO Composio tools get — the
          // guard and approval cards behave identically across postures.
          risk: composioToolRisk(tags),
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
