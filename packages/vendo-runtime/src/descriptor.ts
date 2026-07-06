/**
 * Tool descriptor side table for the Vendo agent runtime.
 *
 * The Vercel ai SDK v6 `Tool` type carries no `annotations` field, and the
 * MCP/Composio adapters surface annotation hints inconsistently. The ingestion
 * layer captures a `ToolDescriptor` once at registration time so the guardrail
 * policy engine always reads from a single, normalised source of truth.
 */

/**
 * Where a tool originated — used for merge precedence and provenance.
 *
 * `"control"` is RESERVED for Vendo's own control-plane tools: the engine's
 * built-in `render_view`/`request_connect`, conversational steering
 * (`always_ask_before`/`stop_asking_about`), and automation authoring tools.
 * These are the ONLY tools `judgePolicy`/`cautionBreaker`/`volumeBreaker`
 * exempt (ENG-193 PR #40 review — ENG-193 item A: the judge/breaker exemption
 * must never fall through to host-supplied server tools). `"engine"` is a
 * mount-registered SERVER tool the host itself supplies (e.g. `vendo/server`'s
 * `options.tools`, a demo's `extraTools`) — judged/breaker-gated exactly like
 * any other tool, NOT exempt. Do not repurpose `"engine"` for control-plane
 * tools again; use `"control"`.
 */
export type ToolSource = "caller" | "engine" | "control" | "composio" | "mcp";

/** Standard MCP annotation hints surfaced on a registered tool. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Where a tool call physically runs. `"server"` (default) executes in-process
 * via the tool's own `execute`; `"client"` streams the call to the user's
 * browser, which executes it on their existing session and returns the result
 * (topology B host-API tools, ENG-202). A tool opts into `"client"` by
 * carrying `vendoExecutor: "client"` (see `hostToolset`).
 */
export type ToolExecutor = "server" | "client";

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
  /** Where the call executes. Absent means `"server"`. */
  executor?: ToolExecutor;
  /** Human description captured at ingestion (feeds the capability summary). */
  description?: string;
  /** Toolkit id for integration tools (e.g. "gmail"), when derivable. */
  toolkit?: string;
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

  const executor: ToolExecutor =
    isObj && (tool as Record<string, unknown>)["vendoExecutor"] === "client"
      ? "client"
      : "server";

  const description =
    isObj && typeof (tool as Record<string, unknown>)["description"] === "string"
      ? ((tool as Record<string, unknown>)["description"] as string)
      : undefined;

  // Composio names its tools TOOLKIT_ACTION (GMAIL_FETCH_EMAILS) — derive the
  // toolkit id from the prefix for integration-sourced tools.
  const toolkit =
    source === "composio" && name.includes("_")
      ? name.slice(0, name.indexOf("_")).toLowerCase()
      : undefined;

  return { name, source, annotations, hasExecute, kind, executor, description, toolkit };
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
