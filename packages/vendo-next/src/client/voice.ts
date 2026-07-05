"use client";

/**
 * Zero-config voice driver for `@vendoai/next/client` (ENG-185).
 *
 * Hosts that use `createVendoHandler()` and set OPENAI_API_KEY get the same
 * topology as chat: the server only mints an ephemeral Realtime secret, while
 * host API tools execute in this browser on the user's existing session.
 */
import {
  annotationsToTier,
  createRealtimeVoiceDriver,
  replayRegistry,
  type VoiceDriver,
  type VoiceToolDef,
} from "@vendoai/shell";
import {
  buildVoiceInstructions,
  capabilitySummary,
  executeHostToolCall,
  type GeneratedPayload,
  type HostToolDefinition,
  type ToolSummaryInput,
  type UINode,
} from "@vendoai/core";

export interface CreateVendoVoiceOptions {
  basePath?: string;
  productName?: string;
  hostTools?: HostToolDefinition[];
  instructionsExtra?: string[];
  /** Whether to expose the handler-backed integrations tools in voice. */
  integrations?: boolean;
}

interface SourceDecl {
  tool?: string;
  input?: unknown;
  rowsPath?: string;
}

interface VoiceInternals {
  tools: VoiceToolDef[];
  instructions: string;
  greeting: string;
  clearResults(): void;
  recordResult(tool: string, input: unknown, output: unknown): void;
  tableView(input: unknown): UINode | undefined;
  keyValueView(input: unknown): UINode | undefined;
  moneyFlowView(input: unknown): UINode | undefined;
}

const SESSION_RESULTS_MAX = 32;

const SOURCE_PARAM = {
  type: "object",
  description:
    "Where the shown data came from, when it came from ONE tool call you made: the tool name, the exact input you passed, and the JSON pointer to the row array inside that tool's result (e.g. '/data/transactions'). Use raw field names as column keys when declaring this. Makes the view refreshable when pinned.",
  properties: {
    tool: { type: "string" },
    input: { type: "object" },
    rowsPath: { type: "string" },
  },
  required: ["tool", "rowsPath"],
} as const;

const MECHANIC_TOOLS = new Set([
  "show_table",
  "show_key_value",
  "show_money_flow",
  "list_integrations",
  "request_connect",
]);

function cleanName(productName: string | undefined): string {
  const trimmed = productName?.trim();
  return trimmed ? trimmed : "Assistant";
}

/** Key-order-stable stringify for matching source declarations to cached calls. */
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

function genNode(id: string, payload: GeneratedPayload): UINode {
  return { id, kind: "generated", payload };
}

function createVoiceInternals(options: CreateVendoVoiceOptions = {}): VoiceInternals {
  const basePath = options.basePath ?? "/api/vendo";
  const productName = cleanName(options.productName);
  const sessionResults = new Map<string, unknown>();
  let viewSeq = 0;
  const nextId = (prefix: string) => `voice-${prefix}-${++viewSeq}`;

  function recordResult(tool: string, input: unknown, output: unknown): void {
    const key = resultKey(tool, input);
    if (sessionResults.size >= SESSION_RESULTS_MAX && !sessionResults.has(key)) {
      const oldest = sessionResults.keys().next().value as string | undefined;
      if (oldest !== undefined) sessionResults.delete(oldest);
    }
    sessionResults.set(key, output);
  }

  function matchSource(
    source: SourceDecl | undefined,
    columns: Array<{ key: string }>,
  ): { raw: unknown; tool: string; input: Record<string, unknown>; rowsPath: string } | undefined {
    if (!source?.tool || typeof source.rowsPath !== "string") return undefined;
    if (!replayRegistry.has(source.tool)) return undefined;
    const key = resultKey(source.tool, source.input);
    if (!sessionResults.has(key)) return undefined;
    const raw = sessionResults.get(key);
    const rows = resolvePointer(raw, source.rowsPath);
    if (!Array.isArray(rows)) return undefined;
    if (rows.length > 0) {
      const scalar = (v: unknown) =>
        v === null || ["string", "number", "boolean"].includes(typeof v);
      for (const row of rows) {
        if (!row || typeof row !== "object") return undefined;
        const record = row as Record<string, unknown>;
        if (!columns.every((c) => c.key in record && scalar(record[c.key]))) return undefined;
      }
    }
    const input =
      source.input && typeof source.input === "object" && !Array.isArray(source.input)
        ? (source.input as Record<string, unknown>)
        : {};
    return { raw, tool: source.tool, input, rowsPath: source.rowsPath };
  }

  function tableView(input: unknown): UINode | undefined {
    const { title, columns, rows, source } = (input ?? {}) as {
      title?: string;
      columns?: Array<{ key: string; label: string }>;
      rows?: Array<Record<string, unknown>>;
      source?: SourceDecl;
    };
    if (!columns?.length || !rows) return undefined;

    const matched = matchSource(source, columns);
    const tableProps = matched
      ? { columns, rows: { $path: `/source${matched.rowsPath}` } }
      : { columns, rows };
    return genNode(nextId("table"), {
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
    });
  }

  function keyValueView(input: unknown): UINode | undefined {
    const { title, rows } = (input ?? {}) as {
      title?: string;
      rows?: Array<{ label: string; value: string; emphasis?: boolean }>;
    };
    if (!rows?.length) return undefined;
    return genNode(nextId("kv"), {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["kv"] },
        { id: "kv", component: "KeyValue", source: "prewired", props: { title, rows } },
      ],
    });
  }

  function moneyFlowView(input: unknown): UINode | undefined {
    const { title, nodes, links } = (input ?? {}) as {
      title?: string;
      nodes?: Array<{ id: string; label: string }>;
      links?: Array<{ source: string; target: string; value: number }>;
    };
    if (!nodes?.length || !links?.length) return undefined;
    return genNode(nextId("money-flow"), {
      formatVersion: "vendo-genui/v1",
      root: "sankey",
      nodes: [
        {
          id: "sankey",
          component: "Sankey",
          source: "prewired",
          props: { title, nodes, links },
        },
      ],
    });
  }

  const displayTools: VoiceToolDef[] = [
    {
      name: "show_table",
      description:
        "Display structured rows (transactions, comparisons) as a table on screen. Use this to SHOW data, then speak only the headline. Declare `source` when the rows came from a tool call so the view stays refreshable.",
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
        "Display a labelled summary (a receipt, account overview, or status summary) as label/value rows on screen. Use `emphasis: true` on the row that matters.",
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
          source: SOURCE_PARAM,
        },
        required: ["rows"],
      },
      tier: "read",
      execute: async () => ({ shown: true }),
      toView: (input) => keyValueView(input),
    },
    {
      name: "show_money_flow",
      description:
        "Display a Sankey / money-flow diagram on screen. Use for sankey, money-flow, cash-flow, or where-did-money-go asks where value moves between categories.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, label: { type: "string" } },
              required: ["id", "label"],
            },
          },
          links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                target: { type: "string" },
                value: { type: "number" },
              },
              required: ["source", "target", "value"],
            },
          },
        },
        required: ["nodes", "links"],
      },
      tier: "read",
      execute: async () => ({ shown: true }),
      toView: (input) => moneyFlowView(input),
    },
  ];

  const integrationTools: VoiceToolDef[] = options.integrations
    ? [
        {
          name: "list_integrations",
          description: "List the available integrations and whether each is connected.",
          parameters: { type: "object", properties: {} },
          tier: "read",
          execute: async () => {
            const res = await fetch(`${basePath}/integrations`, { cache: "no-store" });
            const json = (await res.json().catch(() => ({}))) as unknown;
            if (!res.ok) throw new Error(`list integrations failed (${res.status})`);
            return json;
          },
        },
        {
          name: "request_connect",
          description:
            "Put a Connect card on screen so the user can link an integration. Only use after list_integrations shows it is available and not already connected.",
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
              id: nextId("connect"),
              kind: "component",
              source: "host",
              name: "Connect",
              props: { toolkit, reason },
            };
          },
        },
      ]
    : [];

  const hostVoiceTools: VoiceToolDef[] = (options.hostTools ?? []).map((def) => {
    const tier = annotationsToTier(def.annotations);
    const run = (input: unknown) =>
      executeHostToolCall(def, (input ?? {}) as Record<string, unknown>);
    if (tier === "read") replayRegistry.register(def.name, run);
    return {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
      tier,
      execute: async (input) => {
        const output = await run(input);
        if (tier === "read") recordResult(def.name, input, output);
        return output;
      },
    };
  });

  const tools = [...displayTools, ...integrationTools, ...hostVoiceTools];
  const instructions = buildInstructions(productName, tools, options.instructionsExtra ?? []);
  const greeting = `Hi, I'm ${productName}'s voice assistant; what can I help with?`;

  return {
    tools,
    instructions,
    greeting,
    clearResults: () => sessionResults.clear(),
    recordResult,
    tableView,
    keyValueView,
    moneyFlowView,
  };
}

function voiceToolSummary(tools: VoiceToolDef[]): ToolSummaryInput[] {
  return tools
    .filter((t) => !MECHANIC_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      tier: t.tier === "read" ? "read" : t.tier === "critical" ? "critical" : "act",
      source: "host",
    }));
}

function buildInstructions(productName: string, tools: VoiceToolDef[], extras: string[]): string {
  return buildVoiceInstructions({
    persona: [
      `You are ${productName}'s voice assistant. Warm, brisk, and plain-spoken.`,
      `Use the available tools to help the user operate ${productName}; tool results are the source of truth.`,
    ].join(" "),
    toolSummary: capabilitySummary(voiceToolSummary(tools)),
    extras: [
      "Use English (US) by default unless the user explicitly switches languages.",
      "Never claim something is on screen without calling a show_* tool first.",
      ...extras,
    ],
  });
}

async function getSession(basePath: string): Promise<{ clientSecret: string; model?: string }> {
  const res = await fetch(`${basePath}/voice/session`, {
    method: "POST",
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    clientSecret?: unknown;
    model?: unknown;
    error?: unknown;
  };
  if (!res.ok) {
    throw new Error(typeof json.error === "string" ? json.error : `voice session failed (${res.status})`);
  }
  if (typeof json.clientSecret !== "string" || json.clientSecret.length === 0) {
    throw new Error("voice session response did not include clientSecret");
  }
  return {
    clientSecret: json.clientSecret,
    ...(typeof json.model === "string" ? { model: json.model } : {}),
  };
}

export function createVendoVoice(options: CreateVendoVoiceOptions = {}): VoiceDriver {
  const basePath = options.basePath ?? "/api/vendo";
  const internals = createVoiceInternals(options);
  const realtime = createRealtimeVoiceDriver({
    getSession: () => getSession(basePath),
    tools: internals.tools,
    instructions: internals.instructions,
    greeting: internals.greeting,
  });
  return {
    start(emit, init) {
      internals.clearResults();
      return realtime.start(emit, init);
    },
  };
}

/** Internal seams exported for unit tests only. */
export const __voiceTesting = { createVoiceInternals, resolvePointer, stableStringify };
