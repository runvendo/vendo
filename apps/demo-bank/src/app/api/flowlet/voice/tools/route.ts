/**
 * The voice ⇄ Composio bridge (ENG-185): integration tools for the VOICE
 * agent. Chat runs its loop server-side, so Composio executes in-process;
 * voice tool calls land in the browser (topology B), and the browser cannot
 * run Composio (Node SDK + secret key). This route is the one server leg:
 *
 *   GET  → tool definitions for the CONNECTED toolkits (name, description,
 *          JSON-schema parameters, danger tier from MCP annotations) — the
 *          browser registers them with the realtime session.
 *   POST → execute ONE named tool with the demo principal and return the
 *          result. The stage's consent bar gates act/critical tiers before
 *          the browser ever calls here; server-side re-verification of that
 *          consent is ENG-193's signed-approval work.
 *
 * Ingestion is shared with chat (`ingestComposioTools`) and cached per
 * connected-toolkit set, mirroring the chat route's agent cache.
 */
import { createComposioClient, ingestComposioTools, type ToolDescriptor } from "@flowlet/runtime";
import { capToolOutput } from "@flowlet/core";
import type { ToolSet } from "ai";
import { connectedToolkits } from "@/flowlet/connections-store";
import { DEMO_PRINCIPAL } from "@/flowlet/principal";
import { demoGateResponse, demoRequestAllowed } from "@/flowlet/local-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Session tool budget: enough for gmail+slack essentials without drowning
 *  the realtime session in schemas. */
const MAX_TOOLS = 40;

/** Realtime tokens are the expensive ones — cap integration results hard. */
const VOICE_TOOL_OUTPUT_BUDGET = { maxChars: 6_000, attachNote: true } as const;

const composioClient = createComposioClient({});
type Ingested = { toolset: ToolSet; descriptors: ToolDescriptor[] };
const cache = new Map<string, Promise<Ingested>>();

async function ingested(): Promise<Ingested> {
  const toolkits = [...connectedToolkits()].sort();
  const key = toolkits.join(",");
  let entry = cache.get(key);
  if (!entry) {
    entry = ingestComposioTools({
      principal: DEMO_PRINCIPAL,
      config: { toolkits },
      client: composioClient,
    }).catch((err) => {
      cache.delete(key); // don't cache failures — retry next call
      throw err;
    });
    cache.set(key, entry);
  }
  return entry;
}

/** Composio tools mostly ship WITHOUT annotation hints, which fail-closed
 *  gates every inbox READ behind a consent bar — safe but so naggy that users
 *  drown in permission asks (observed live). Name-based enrichment fills the
 *  gap: unmistakable read verbs auto-allow, destructive verbs escalate, and
 *  anything ambiguous stays gated at act. */
const READ_NAME = /(FETCH|GET|LIST|SEARCH|READ|FIND|LOOKUP|RETRIEVE|HISTORY)/;
const DESTRUCTIVE_NAME = /(DELETE|REMOVE|DESTROY|PURGE|TRASH)/;

function tierOf(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }): string {
  if (annotations.readOnlyHint) return "read";
  if (annotations.destructiveHint) return "critical";
  if (DESTRUCTIVE_NAME.test(name)) return "critical";
  if (READ_NAME.test(name)) return "read";
  return "act";
}

/** Best-effort JSON schema off an ai-SDK tool (jsonSchema wrapper or loose). */
function schemaOf(tool: unknown): Record<string, unknown> {
  const input = (tool as { inputSchema?: { jsonSchema?: unknown } }).inputSchema;
  const json = input?.jsonSchema;
  if (json && typeof json === "object") return json as Record<string, unknown>;
  return { type: "object", properties: {}, additionalProperties: true };
}

export async function GET(req: Request): Promise<Response> {
  // Parity with the chat loop's gate: these tools act AS the demo principal.
  if (!demoRequestAllowed(req)) return demoGateResponse();
  try {
    const { toolset, descriptors } = await ingested();
    const byName = new Map(descriptors.map((d) => [d.name, d]));
    const tools = Object.entries(toolset)
      .slice(0, MAX_TOOLS)
      .map(([name, tool]) => ({
        name,
        description: String((tool as { description?: string }).description ?? name),
        parameters: schemaOf(tool),
        tier: tierOf(name, byName.get(name)?.annotations ?? {}),
      }));
    return Response.json({ tools, truncated: Object.keys(toolset).length > MAX_TOOLS });
  } catch (error) {
    console.error("[flowlet voice] integration tool listing failed", error);
    return Response.json({ tools: [] });
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!demoRequestAllowed(req)) return demoGateResponse();
  const { tool, input } = (await req.json().catch(() => ({}))) as { tool?: string; input?: unknown };
  if (!tool) return Response.json({ error: "missing tool" }, { status: 400 });
  const { toolset } = await ingested();
  const entry = toolset[tool] as { execute?: (input: unknown, opts: unknown) => Promise<unknown> } | undefined;
  if (!entry?.execute) {
    return Response.json({ error: `unknown or non-executable tool ${tool}` }, { status: 404 });
  }
  try {
    const result = await entry.execute(input ?? {}, { toolCallId: `voice-${Date.now()}`, messages: [] });
    // Voice budget is tighter than chat's (realtime tokens are the expensive
    // ones); capping here also covers saved-view REPLAY through this bridge,
    // so initial and refreshed shapes match (spec §5).
    return Response.json({ result: capToolOutput(result, VOICE_TOOL_OUTPUT_BUDGET).result });
  } catch (error) {
    console.error("[flowlet voice] integration tool failed", tool, error);
    return Response.json(
      { error: error instanceof Error ? error.message : "tool execution failed" },
      { status: 502 },
    );
  }
}
