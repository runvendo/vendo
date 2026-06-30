/**
 * Tool descriptor side table for the Flowlet agent runtime.
 *
 * The Vercel ai SDK v6 `Tool` type carries no `annotations` field, and the
 * MCP/Composio adapters surface annotation hints inconsistently. The ingestion
 * layer captures a `ToolDescriptor` once at registration time so the guardrail
 * policy engine always reads from a single, normalised source of truth.
 */

/** Where a tool originated — used for merge precedence and provenance. */
export type ToolSource = "caller" | "engine" | "composio" | "mcp";

/** Standard MCP annotation hints surfaced on a registered tool. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Normalised, source-of-truth descriptor stored per registered tool. */
export interface ToolDescriptor {
  name: string;
  source: ToolSource;
  annotations: ToolAnnotations;
  /** `true` when the tool object carries a callable `execute` property. */
  hasExecute: boolean;
  /**
   * The ai SDK tool discriminator (`"function"`, `"dynamic"`,
   * `"provider-defined"`, …). Defaults to `"function"` when absent.
   */
  kind: string;
}

/**
 * Build a `ToolDescriptor` from a raw tool object received at ingestion time.
 *
 * @param name - The canonical tool name.
 * @param tool - The raw tool value (typed `unknown`; guarded defensively).
 * @param source - Where the tool came from.
 * @param explicitAnnotations - When the ingestion layer already knows the real
 *   annotations (e.g. from the MCP tool manifest), pass them here; they take
 *   priority over anything embedded in `tool`.
 */
export function buildDescriptor(
  name: string,
  tool: unknown,
  source: ToolSource,
  explicitAnnotations?: ToolAnnotations,
): ToolDescriptor {
  const isObj = tool !== null && typeof tool === "object";

  // Resolve annotations: explicit > _meta.annotations > tool.annotations > {}
  let annotations: ToolAnnotations;
  if (explicitAnnotations !== undefined) {
    annotations = explicitAnnotations;
  } else if (isObj && hasMetaAnnotations(tool)) {
    const meta = (tool as Record<string, Record<string, unknown>>)["_meta"]!;
    annotations = meta["annotations"] as ToolAnnotations;
  } else if (isObj && hasTopLevelAnnotations(tool)) {
    annotations = (tool as Record<string, unknown>)["annotations"] as ToolAnnotations;
  } else {
    annotations = {};
  }

  const hasExecute =
    isObj &&
    typeof (tool as Record<string, unknown>)["execute"] === "function";

  const kind =
    isObj &&
    typeof (tool as Record<string, unknown>)["type"] === "string"
      ? ((tool as Record<string, unknown>)["type"] as string)
      : "function";

  return { name, source, annotations, hasExecute, kind };
}

// ---------------------------------------------------------------------------
// Internal type guards
// ---------------------------------------------------------------------------

function hasMetaAnnotations(obj: object): boolean {
  const meta = (obj as Record<string, unknown>)["_meta"];
  return (
    meta !== null &&
    typeof meta === "object" &&
    "annotations" in (meta as object) &&
    typeof (meta as Record<string, unknown>)["annotations"] === "object" &&
    (meta as Record<string, unknown>)["annotations"] !== null
  );
}

function hasTopLevelAnnotations(obj: object): boolean {
  const ann = (obj as Record<string, unknown>)["annotations"];
  return ann !== null && typeof ann === "object";
}
