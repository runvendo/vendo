/**
 * GET|POST /voice/tools — server bridge for connected integration tools.
 *
 * Voice tools execute in the browser, but Composio tools need the server-side
 * SDK and API key. This bridge gives the Realtime session schemas for the
 * currently connected toolkits and executes selected calls on behalf of the
 * guarded principal, with a voice-sized output cap before results hit the
 * expensive realtime context (ENG-185).
 */
import type { ToolSet } from "ai";
import { capToolOutput } from "@vendoai/core";
import {
  createComposioClient,
  ingestComposioTools,
  type ComposioClient,
  type ToolDescriptor,
  type VendoPrincipal,
} from "@vendoai/runtime";
import type { ConnectionsStore } from "./connections.js";

const MAX_TOOLS = 40;
const VOICE_TOOL_OUTPUT_BUDGET = { maxChars: 6_000, attachNote: true } as const;

interface Ingested {
  toolset: ToolSet;
  descriptors: ToolDescriptor[];
}

export interface VoiceToolsDeps {
  store: ConnectionsStore;
  enabled: boolean;
  principal: VendoPrincipal;
  /** Injectable for tests; defaults to a lazily-built real client. */
  client?: ComposioClient;
  maxTools?: number;
  /**
   * Server-executed CONTROL tools (automation authoring: create_automation,
   * update_automation) exposed to the voice session so it reaches parity with
   * chat — the same tools the chat loop registers server-side. Bridged, not
   * browser-run, because authoring mutates the durable automation store.
   * Listed regardless of `enabled` (that flag only gates Composio integrations).
   */
  controlTools?: ToolSet;
}

/** Tier for an authoring/control tool: they mutate state, so act-tier
 *  (voice-approved) unless a read-only hint says otherwise. */
function controlTier(name: string): "read" | "act" | "critical" {
  if (READ_NAME.test(name)) return "read";
  return "act";
}

function controlToolList(deps: VoiceToolsDeps, maxTools: number): Array<{
  name: string; description: string; parameters: Record<string, unknown>; tier: "read" | "act" | "critical";
}> {
  const control = deps.controlTools ?? {};
  return Object.entries(control)
    .slice(0, maxTools)
    .map(([name, tool]) => ({
      name,
      description: String((tool as { description?: string }).description ?? name),
      parameters: schemaOf(tool),
      tier: controlTier(name),
    }));
}

let realClient: ComposioClient | undefined;
function getClient(deps: VoiceToolsDeps): ComposioClient {
  if (deps.client) return deps.client;
  if (!realClient) realClient = createComposioClient({ apiKey: process.env["COMPOSIO_API_KEY"] });
  return realClient;
}

const cache = new Map<string, Promise<Ingested>>();

async function ingested(deps: VoiceToolsDeps): Promise<Ingested> {
  const toolkits = [...(await deps.store.connectedToolkits())].sort();
  if (toolkits.length === 0) return { toolset: {}, descriptors: [] };

  // Test fakes should not share state across cases. Production cache keys on
  // principal+toolkits because Composio schemas are per connected account.
  if (deps.client) {
    return ingestComposioTools({
      principal: deps.principal,
      config: { toolkits },
      client: deps.client,
    });
  }

  const key = `${deps.principal.userId}\0${toolkits.join(",")}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = ingestComposioTools({
      principal: deps.principal,
      config: { toolkits },
      client: getClient(deps),
    }).catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, entry);
  }
  return entry;
}

const READ_NAME = /(FETCH|GET|LIST|SEARCH|READ|FIND|LOOKUP|RETRIEVE|HISTORY)/;
const DESTRUCTIVE_NAME = /(DELETE|REMOVE|DESTROY|PURGE|TRASH)/;

function tierOf(name: string, annotations: ToolDescriptor["annotations"]): "read" | "act" | "critical" {
  if (annotations.readOnlyHint) return "read";
  if (annotations.destructiveHint) return "critical";
  if (DESTRUCTIVE_NAME.test(name)) return "critical";
  if (READ_NAME.test(name)) return "read";
  return "act";
}

function schemaOf(tool: unknown): Record<string, unknown> {
  const input = (tool as { inputSchema?: { jsonSchema?: unknown } }).inputSchema;
  const json = input?.jsonSchema;
  if (json && typeof json === "object") return json as Record<string, unknown>;
  return { type: "object", properties: {}, additionalProperties: true };
}

export async function handleVoiceToolsGet(_req: Request, deps: VoiceToolsDeps): Promise<Response> {
  const maxTools = deps.maxTools ?? MAX_TOOLS;
  // Control (authoring) tools are independent of the Composio flag.
  const control = controlToolList(deps, maxTools);
  if (!deps.enabled) return Response.json({ tools: control, truncated: false });
  try {
    const { toolset, descriptors } = await ingested(deps);
    const byName = new Map(descriptors.map((d) => [d.name, d]));
    const integration = Object.entries(toolset)
      .slice(0, maxTools)
      .map(([name, tool]) => ({
        name,
        description: String((tool as { description?: string }).description ?? name),
        parameters: schemaOf(tool),
        tier: tierOf(name, byName.get(name)?.annotations ?? {}),
      }));
    return Response.json({
      tools: [...control, ...integration],
      truncated: Object.keys(toolset).length > maxTools,
    });
  } catch (error) {
    console.error("[vendo voice] integration tool listing failed", error);
    return Response.json({ tools: control, truncated: false });
  }
}

export async function handleVoiceToolsPost(req: Request, deps: VoiceToolsDeps): Promise<Response> {
  const { tool, input } = (await req.json().catch(() => ({}))) as {
    tool?: unknown;
    input?: unknown;
  };
  if (typeof tool !== "string" || tool.length === 0) {
    return Response.json({ error: "missing tool" }, { status: 400 });
  }

  // Control (authoring) tools first — they don't need Composio ingestion.
  const control = deps.controlTools ?? {};
  let entry = control[tool] as
    | { execute?: (input: unknown, opts: unknown) => Promise<unknown> }
    | undefined;
  if (!entry?.execute && deps.enabled) {
    const { toolset } = await ingested(deps);
    entry = toolset[tool] as typeof entry;
  }
  if (!entry?.execute) {
    return Response.json({ error: `unknown or non-executable tool ${tool}` }, { status: 404 });
  }

  try {
    const result = await entry.execute(input ?? {}, { toolCallId: `voice-${Date.now()}`, messages: [] });
    return Response.json({ result: capToolOutput(result, VOICE_TOOL_OUTPUT_BUDGET).result });
  } catch (error) {
    console.error("[vendo voice] integration tool failed", tool, error);
    return Response.json(
      { error: error instanceof Error ? error.message : "tool execution failed" },
      { status: 502 },
    );
  }
}
