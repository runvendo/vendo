/**
 * Maple's REALTIME voice wiring (ENG-185): the same host-API tool definitions
 * chat uses, adapted for the voice agent — executed in the browser on the
 * user's session (topology B), gated by the same annotation-derived tiers,
 * with two display tools so the agent can put views on the stage.
 *
 * Falls back to the scripted choreography when the host has no
 * OPENAI_API_KEY (the /api/vendo/voice endpoint answers 503) — the mic
 * always does something sensible.
 */
import {
  annotationsToTier,
  createRealtimeVoiceDriver,
  type VoiceDriver,
  type VoiceDriverHandle,
  type VoiceEvent,
  type VoiceSessionInit,
  type VoiceToolDef,
} from "@vendoai/shell";
import {
  buildVoiceInstructions,
  capabilitySummary,
  executeHostToolCall,
  renderFormatHints,
  type FieldFormat,
  type ToolSummaryInput,
  type UINode,
} from "@vendoai/core";
import { mapleHostToolDefs } from "@/vendo/host-tools";
import { createComposioIntegrations, integrationCatalogIds } from "./integrations";
import { mapleVoiceDriver as scriptedFallback } from "./voice-demo";

let viewSeq = 0;

/**
 * Per-session cache of read-tool results (spec §3): the model's `source`
 * declaration is matched against what the CLIENT actually fetched, so the
 * data-bound payload stores the verbatim (capped) result — the model never
 * has to round-trip raw data. Bounded FIFO; latest result per key wins.
 */
const sessionResults = new Map<string, unknown>();
const SESSION_RESULTS_MAX = 32;

/** Declared result-field formats by tool name: a BOUND table shows the raw
 *  cached result verbatim (the model's formatting is discarded by design),
 *  so the format must be stamped onto the columns for the Table to apply. */
const formatsByTool = new Map<string, Record<string, FieldFormat>>(
  mapleHostToolDefs
    .filter((def) => def.formats)
    .map((def) => [def.name, def.formats as Record<string, FieldFormat>]),
);

/** Key-order-stable stringify: the model's `source.input` may order fields
 *  differently than the call it mirrors ({limit, category} vs {category,
 *  limit}) — both must hit the same cache entry. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const resultKey = (tool: string, input: unknown): string =>
  `${tool}:${stableStringify(input ?? {})}`;
function recordResult(tool: string, input: unknown, output: unknown): void {
  const key = resultKey(tool, input);
  if (sessionResults.size >= SESSION_RESULTS_MAX && !sessionResults.has(key)) {
    const oldest = sessionResults.keys().next().value as string | undefined;
    if (oldest !== undefined) sessionResults.delete(oldest);
  }
  sessionResults.set(key, output);
}

/** The model's optional provenance declaration on display tools. */
interface SourceDecl {
  tool?: string;
  input?: unknown;
  rowsPath?: string;
}

/** Resolve a JSON pointer ("/data/transactions") into a value, or undefined. */
function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return value;
  let current: unknown = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (current && typeof current === "object")
      current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}

/** Validate a source declaration against the session cache: the pointed-at
 *  value must be an array of records whose fields cover the column keys, and
 *  the result must be present in this session. Any failure → snapshot. */
function matchSource(
  source: SourceDecl | undefined,
  columns: Array<{ key: string }>,
): { raw: unknown; tool: string; input: unknown; rowsPath: string } | undefined {
  if (!source?.tool || typeof source.rowsPath !== "string") return undefined;
  const key = resultKey(source.tool, source.input);
  if (!sessionResults.has(key)) return undefined;
  const raw = sessionResults.get(key);
  const rows = resolvePointer(raw, source.rowsPath);
  if (!Array.isArray(rows)) return undefined;
  // An EMPTY result is still a valid declaration; column validation only
  // applies when rows exist.
  if (rows.length > 0) {
    // Declared columns must exist AND be scalar in EVERY row (review P1:
    // heterogeneous rows can be scalar in row 1 and nested in row 2): bound
    // cells render raw values, so a nested field would show as an em dash —
    // worse than the model's own formatted snapshot.
    const scalar = (v: unknown) =>
      v === null || ["string", "number", "boolean"].includes(typeof v);
    for (const row of rows) {
      if (!row || typeof row !== "object") return undefined;
      const record = row as Record<string, unknown>;
      if (!columns.every((c) => c.key in record && scalar(record[c.key]))) return undefined;
    }
  }
  return { raw, tool: source.tool, input: source.input ?? {}, rowsPath: source.rowsPath };
}

/** Wrap rows/columns from the model into a sandbox-rendered Table view. When
 *  the model declares a valid `source`, the payload is DATA-BOUND (rows via
 *  $path into the verbatim cached result) and preserves query provenance. */
function tableView(input: unknown): UINode | undefined {
  const { title, columns, rows, source } = (input ?? {}) as {
    title?: string;
    columns?: Array<{ key: string; label: string }>;
    rows?: Array<Record<string, unknown>>;
    source?: SourceDecl;
  };
  if (!columns?.length || !rows) return undefined;

  const matched = matchSource(source, columns);
  // Bound rows are guaranteed RAW (verbatim cached result), so the source
  // tool's declared formats apply deterministically. Snapshot rows are the
  // model's own — its prompt-side format rules govern those.
  const formats = matched ? formatsByTool.get(matched.tool) : undefined;
  const boundColumns = formats
    ? columns.map((c) => (formats[c.key] ? { ...c, format: formats[c.key] } : c))
    : columns;
  const tableProps = matched
    ? { columns: boundColumns, rows: { $path: `/source${matched.rowsPath}` } }
    : { columns, rows };
  return {
    id: `voice-table-${++viewSeq}`,
    kind: "generated",
    payload: {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: title ? ["title", "table"] : ["table"] },
        ...(title ? [{ id: "title", component: "Text", props: { text: title } }] : []),
        { id: "table", component: "Table", source: "prewired", props: tableProps },
      ],
      ...(matched
        ? {
            data: { source: matched.raw },
            queries: [{ path: "/source", tool: matched.tool, input: matched.input }],
          }
        : {}),
    },
  };
}

/** Wrap label/value pairs into a KeyValue view. */
function keyValueView(input: unknown): UINode | undefined {
  const { title, rows } = (input ?? {}) as {
    title?: string;
    rows?: Array<{ label: string; value: string; emphasis?: boolean }>;
  };
  if (!rows?.length) return undefined;
  return {
    id: `voice-kv-${++viewSeq}`,
    kind: "generated",
    payload: {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["kv"] },
        { id: "kv", component: "KeyValue", source: "prewired", props: { title, rows } },
      ],
    },
  };
}

/** Optional provenance declaration: lets the client build a data-bound
 *  payload from its own cached copy of the result. */
const SOURCE_PARAM = {
  type: "object",
  description:
    "Where the shown data came from, when it came from ONE tool call you made: the tool name, the exact input you passed, and the JSON pointer to the row array inside that tool's result (e.g. '/data/transactions'). Use raw field names as column keys so the client can bind the exact rows.",
  properties: {
    tool: { type: "string" },
    input: { type: "object" },
    rowsPath: { type: "string" },
  },
  required: ["tool", "rowsPath"],
} as const;

const displayTools: VoiceToolDef[] = [
  {
    name: "show_table",
    description:
      "Display structured rows (transactions, comparisons) as a table on screen. Use this to SHOW data — then speak only the headline. Declare `source` when the rows came from a tool call so the client can bind the exact result.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, label: { type: "string" } },
            required: ["key", "label"],
          },
        },
        rows: { type: "array", items: { type: "object" } },
        source: SOURCE_PARAM,
      },
      required: ["columns", "rows"],
    },
    tier: "read",
    execute: async () => ({ shown: true }),
    toView: (input) => tableView(input),
  },
  {
    name: "show_key_value",
    description:
      "Display a labelled summary (a receipt, an account overview) as label/value rows on screen. Use `emphasis: true` on the row that matters.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
              emphasis: { type: "boolean" },
            },
            required: ["label", "value"],
          },
        },
        // Accepted for schema symmetry with show_table; label/value rows are
        // model-authored prose, so a raw result can't bind — stays a snapshot.
        source: SOURCE_PARAM,
      },
      required: ["rows"],
    },
    tier: "read",
    execute: async () => ({ shown: true }),
    toView: (input) => keyValueView(input),
  },
];

// (A demo-fiction `transfer_funds` critical tool lived here briefly — removed:
// the model wove imaginary transfers into real conversations, and a stale
// pending transfer approval then swallowed the user's "yes" meant for another
// tool. Critical-tier coverage comes from real host annotations, not fiction.)

/** Integrations by voice: listing is a plain read; CONNECTING renders the
 *  same host Connect card chat uses — the card is the consent, and clicking
 *  it provides the user gesture the OAuth popup needs. */
const voiceIntegrations = createComposioIntegrations();
const integrationTools: VoiceToolDef[] = [
  {
    name: "list_integrations",
    description: "List the available integrations (Gmail, Slack, …) and whether each is connected.",
    parameters: { type: "object", properties: {} },
    tier: "read",
    execute: () => voiceIntegrations.list(),
  },
  {
    name: "request_connect",
    description:
      "Put a Connect card on screen so the user can link an integration (OAuth). ONLY for toolkits that are NOT already connected — if a toolkit's tools (GMAIL_*, SLACK_*, …) are in your tool list, it IS connected: use them directly, never show this card.",
    parameters: {
      type: "object",
      properties: {
        toolkit: { type: "string", description: "integration id, e.g. gmail, slack, notion" },
        reason: { type: "string", description: "one short line on why" },
      },
      required: ["toolkit"],
    },
    tier: "read",
    execute: async () => ({ shown: true, note: "Card is on screen; the user taps Connect to finish." }),
    toView: (input) => {
      const { toolkit, reason } = (input ?? {}) as { toolkit?: string; reason?: string };
      if (!toolkit) return undefined;
      return {
        id: `voice-connect-${++viewSeq}`,
        kind: "component",
        source: "host",
        name: "Connect",
        props: { toolkit, reason },
      };
    },
  },
];

/** Every Maple host-API operation, straight through the chat-side executor.
 *  Read-tier results are recorded for `source` matching. */
const hostVoiceTools: VoiceToolDef[] = mapleHostToolDefs.map((def) => {
  const tier = annotationsToTier(def.annotations);
  const run = (input: unknown) =>
    executeHostToolCall(def, (input ?? {}) as Record<string, unknown>);
  // Declared result-field formats travel with the voice tool too — parity
  // with the chat path's hostToolset (a voice model reads cents/date rules
  // in the same place it reads what the tool does).
  const hints = def.formats ? renderFormatHints(def.formats) : "";
  return {
    name: def.name,
    description: hints ? `${def.description}\n${hints}` : def.description,
    parameters: def.inputSchema,
    tier,
    execute: async (input) => {
      const output = await run(input);
      if (tier === "read") recordResult(def.name, input, output);
      return output;
    },
  };
});

/** Protocol/display tools are mechanics, not capabilities — keep them out of
 *  the "what can you do" summary. */
const MECHANIC_TOOLS = new Set(["show_table", "show_key_value", "list_integrations", "request_connect"]);

/** Map the composed VoiceToolDef list to the shared capability contract. */
function voiceToolSummary(tools: VoiceToolDef[]): ToolSummaryInput[] {
  return tools
    .filter((t) => !MECHANIC_TOOLS.has(t.name))
    .map((t) => {
      // Composio bridge tools are named TOOLKIT_ACTION (GMAIL_FETCH_EMAILS).
      const upper = /^[A-Z0-9]+_/.test(t.name);
      return {
        name: t.name,
        description: t.description,
        tier: t.tier === "read" ? ("read" as const) : t.tier === "critical" ? ("critical" as const) : ("act" as const),
        source: upper ? ("integration" as const) : ("host" as const),
        ...(upper ? { toolkit: t.name.slice(0, t.name.indexOf("_")).toLowerCase() } : {}),
      };
    });
}

/** Maple's voice prompt — recomposed onto the shared prompt core (spec §1):
 *  platform rules (anti-yap register, show-vs-say, source declarations,
 *  consent recency, guardrails) come from @vendoai/core; only the persona and
 *  the cents convention are Maple's. Assembled at session start so the
 *  capability summary reflects the LIVE tool list. */
function buildInstructions(tools: VoiceToolDef[]): string {
  return buildVoiceInstructions({
    hostName: "Maple",
    persona: [
      "You are Maple's voice assistant — Maple is the user's bank. Warm, brisk, plain-spoken.",
      "You can read the user's real accounts, transactions, cards, insights and payees through",
      "your tools; the data comes back as JSON from Maple's own API.",
    ].join(" "),
    toolSummary: capabilitySummary(voiceToolSummary(tools), integrationCatalogIds),
    extras: [
      "Money amounts in the API are integer CENTS — always convert and display as dollars (941220 → $9,412.20), on screen and aloud.",
    ],
  });
}

const GREETING =
  "Greet the user in ONE short sentence: you're Maple's voice assistant, ask what they need. Do not list capabilities.";

/** Integration (Composio) tools for the connected toolkits — executed via the
 *  server bridge (the browser can't run Composio; see the route's header). */
async function fetchIntegrationVoiceTools(): Promise<VoiceToolDef[]> {
  try {
    const res = await fetch("/api/vendo/voice/tools");
    if (!res.ok) return [];
    const body = (await res.json()) as {
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown>; tier: string }>;
    };
    return (body.tools ?? []).map((tool) => {
      const tier: VoiceToolDef["tier"] =
        tool.tier === "read" ? "read" : tool.tier === "critical" ? "critical" : "act";
      const run = async (input: unknown) => {
        const exec = await fetch("/api/vendo/voice/tools", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool: tool.name, input }),
        });
        const json = (await exec.json()) as { result?: unknown; error?: string };
        if (!exec.ok) throw new Error(json.error ?? `integration tool failed (${exec.status})`);
        return json.result;
      };
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        tier,
        execute: async (input) => {
          const output = await run(input);
          if (tier === "read") recordResult(tool.name, input, output);
          return output;
        },
      };
    });
  } catch {
    return []; // integrations stay chat-only this session — never fatal
  }
}

/**
 * Mint-and-fallback: mint the session grant up front; with a grant, run the
 * realtime driver on it (one mint per session, no double-spend); without one
 * (no key on the host), play the scripted choreography instead. Handle calls
 * made before the mint settles are forwarded once the inner driver exists.
 */
export const mapleRealtimeVoiceDriver: VoiceDriver = {
  start(emit: (event: VoiceEvent) => void, init?: VoiceSessionInit): VoiceDriverHandle {
    let inner: VoiceDriverHandle | null = null;
    let stopped = false;
    const queued: Array<(handle: VoiceDriverHandle) => void> = [];
    const withInner = (fn: (handle: VoiceDriverHandle) => void) => {
      if (inner) fn(inner);
      else queued.push(fn);
    };
    const adopt = (handle: VoiceDriverHandle) => {
      inner = handle;
      for (const fn of queued.splice(0)) fn(handle);
    };

    // Fresh session, fresh provenance: stale results from an earlier session
    // must never validate a new session's source declarations.
    sessionResults.clear();

    emit({ type: "status", status: "connecting" });
    void fetch("/api/vendo/voice", { method: "POST" })
      .then(async (res) => {
        if (stopped) return;
        if (!res.ok) {
          console.info("[vendo voice] no realtime key — running the scripted demo session");
          adopt(scriptedFallback.start(emit, init));
          return;
        }
        const [grant, composioTools] = await Promise.all([
          res.json() as Promise<{ clientSecret: string; model?: string }>,
          fetchIntegrationVoiceTools(),
        ]);
        if (stopped) return;
        const tools = [...displayTools, ...integrationTools, ...composioTools, ...hostVoiceTools];
        const driver = createRealtimeVoiceDriver({
          getSession: async () => grant,
          tools,
          instructions: buildInstructions(tools),
          greeting: GREETING,
        });
        // Forward init through the mint wrapper — before this, the session
        // brief/carry-over silently never reached the realtime driver.
        adopt(driver.start(emit, init));
      })
      .catch(() => {
        if (stopped) return;
        adopt(scriptedFallback.start(emit, init));
      });

    return {
      mute: (muted) => withInner((h) => h.mute(muted)),
      end: () => withInner((h) => h.end()),
      approve: (id, via) => withInner((h) => h.approve(id, via)),
      decline: (id) => withInner((h) => h.decline(id)),
      stop: () => {
        stopped = true;
        inner?.stop();
      },
    };
  },
};

/** Internal seams exported for unit tests only. */
export const __voiceTesting = { tableView, recordResult, resolvePointer, hostVoiceTools };
