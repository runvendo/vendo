"use client";

/**
 * Zero-config voice driver for `@vendoai/client` (ENG-185).
 *
 * Hosts that use `createVendoHandler()` and set OPENAI_API_KEY get the same
 * topology as chat: the server only mints an ephemeral Realtime secret, while
 * host API tools execute in this browser on the user's existing session.
 */
import {
  annotationsToTier,
  createRealtimeVoiceDriver,
  type VoiceDriver,
  type VoiceDriverHandle,
  type VoiceToolDef,
} from "@vendoai/shell";
import { descriptors } from "@vendoai/components/descriptors";
import {
  buildVoiceInstructions,
  capabilitySummary,
  executeHostToolCall,
  renderFormatHints,
  type FieldFormat,
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
  /** Whether the handler's automations world is enabled — when true, voice
   *  fetches the server-bridged authoring tools (create_automation, …) so it
   *  can compile standing behaviors exactly like the chat loop does. */
  automations?: boolean;
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
  createIntegrationVoiceTools(): Promise<{ tools: VoiceToolDef[]; unregister(): void }>;
  buildInstructions(tools: VoiceToolDef[]): string;
  dispose(): void;
}

const SESSION_RESULTS_MAX = 32;

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

const MECHANIC_TOOLS = new Set([
  "show_table",
  "show_key_value",
  "show_money_flow",
  "list_integrations",
  "request_connect",
]);

const sankeyPropsSchema = descriptors.find((d) => d.name === "Sankey")?.propsSchema;

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

function moneyFlowValidation(input: unknown): { ok: true } | { ok: false; message: string } {
  const parsed = sankeyPropsSchema?.safeParse(input);
  if (parsed) {
    if (parsed.success) return { ok: true };
    return {
      ok: false,
      message:
        parsed.error.issues[0]?.message ??
        "Money-flow diagrams need at least two unique nodes and positive links between known node ids.",
    };
  }

  const { nodes, links } = (input ?? {}) as {
    nodes?: Array<{ id?: unknown }>;
    links?: Array<{ source?: unknown; target?: unknown; value?: unknown }>;
  };
  if (!Array.isArray(nodes) || nodes.length < 2) {
    return { ok: false, message: "Money-flow diagrams need at least two nodes." };
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || node.id.length === 0) {
      return { ok: false, message: "Every money-flow node needs a non-empty string id." };
    }
    if (ids.has(node.id)) return { ok: false, message: "Money-flow node ids must be unique." };
    ids.add(node.id);
  }
  if (!Array.isArray(links) || links.length === 0) {
    return { ok: false, message: "Money-flow diagrams need at least one link." };
  }
  for (const link of links) {
    if (typeof link.value !== "number" || link.value <= 0) {
      return { ok: false, message: "Money-flow link values must be positive numbers." };
    }
    if (typeof link.source !== "string" || !ids.has(link.source)) {
      return { ok: false, message: "Money-flow link sources must reference known node ids." };
    }
    if (typeof link.target !== "string" || !ids.has(link.target)) {
      return { ok: false, message: "Money-flow link targets must reference known node ids." };
    }
  }
  return { ok: true };
}

function createVoiceInternals(options: CreateVendoVoiceOptions = {}): VoiceInternals {
  const basePath = options.basePath ?? "/api/vendo";
  const productName = cleanName(options.productName);
  const sessionResults = new Map<string, unknown>();
  let viewSeq = 0;
  const nextId = (prefix: string) => `voice-${prefix}-${++viewSeq}`;

  // Declared result-field formats by tool name: a BOUND table shows the raw
  // cached result verbatim (the model's formatting is discarded by design),
  // so the format must be stamped onto the columns for the Table to apply.
  const formatsByTool = new Map<string, Record<string, FieldFormat>>(
    (options.hostTools ?? [])
      .filter((def) => def.formats)
      .map((def) => [def.name, def.formats as Record<string, FieldFormat>]),
  );

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
    if (moneyFlowValidation(input).ok === false) return undefined;
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
        "Display structured rows (transactions, comparisons) as a table on screen. Use this to SHOW data, then speak only the headline. Declare `source` when the rows came from a tool call so the client can bind the exact result.",
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
            minItems: 2,
            items: {
              type: "object",
              properties: { id: { type: "string" }, label: { type: "string" } },
              required: ["id", "label"],
            },
          },
          links: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                target: { type: "string" },
                value: { type: "number", exclusiveMinimum: 0 },
              },
              required: ["source", "target", "value"],
            },
          },
        },
        required: ["nodes", "links"],
      },
      tier: "read",
      execute: async (input) => {
        const validation = moneyFlowValidation(input);
        if (!validation.ok) {
          return {
            shown: false,
            error: validation.message,
            repair:
              "Call show_money_flow again with at least two unique node ids and positive links whose source and target reference those node ids.",
          };
        }
        return { shown: true };
      },
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
    // Declared result-field formats travel with the voice tool too — parity
    // with the chat path's hostToolset (the voice model reads cents/date
    // rules in the same place it reads what the tool does).
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

  async function createIntegrationVoiceTools(): Promise<{ tools: VoiceToolDef[]; unregister(): void }> {
    // The /voice/tools bridge carries BOTH connected-integration tools (Composio)
    // and server-executed control tools (automation authoring). Fetch it when
    // either capability is on so voice reaches chat parity.
    if (!options.integrations && !options.automations) return { tools: [], unregister() {} };
    try {
      const res = await fetch(`${basePath}/voice/tools`, { cache: "no-store" });
      if (!res.ok) return { tools: [], unregister() {} };
      const body = (await res.json()) as {
        tools?: Array<{
          name: string;
          description: string;
          parameters: Record<string, unknown>;
          tier: string;
        }>;
      };
      const tools = (body.tools ?? []).map((tool) => {
        const tier: VoiceToolDef["tier"] =
          tool.tier === "read" ? "read" : tool.tier === "critical" ? "critical" : "act";
        const run = async (input: unknown) => {
          const exec = await fetch(`${basePath}/voice/tools`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tool: tool.name, input }),
          });
          const json = (await exec.json().catch(() => ({}))) as { result?: unknown; error?: string };
          if (!exec.ok) throw new Error(json.error ?? `integration tool failed (${exec.status})`);
          return json.result;
        };
        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          tier,
          execute: async (input: unknown) => {
            const output = await run(input);
            if (tier === "read") recordResult(tool.name, input, output);
            return output;
          },
        };
      });
      return {
        tools,
        unregister() {},
      };
    } catch {
      return { tools: [], unregister() {} };
    }
  }

  const tools = [...displayTools, ...integrationTools, ...hostVoiceTools];
  const instructions = buildInstructions(productName, tools, options.instructionsExtra ?? [], options.automations ?? false);
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
    createIntegrationVoiceTools,
    buildInstructions: (sessionTools) => buildInstructions(productName, sessionTools, options.instructionsExtra ?? [], options.automations ?? false),
    dispose() {},
  };
}

function voiceToolSummary(tools: VoiceToolDef[]): ToolSummaryInput[] {
  return tools
    .filter((t) => !MECHANIC_TOOLS.has(t.name))
    .map((t) => {
      const integration = /^[A-Z0-9]+_/.test(t.name);
      return {
        name: t.name,
        description: t.description,
        tier: t.tier === "read" ? "read" : t.tier === "critical" ? "critical" : "act",
        source: integration ? "integration" : "host",
        ...(integration ? { toolkit: t.name.slice(0, t.name.indexOf("_")).toLowerCase() } : {}),
      };
    });
}

const AUTOMATION_VOICE_GUIDANCE =
  "AUTOMATIONS: when the user asks for standing behavior (\"whenever X, do Y\", \"every morning…\", \"if a charge over $75 hits…\"), COMPILE it with the create_automation tool instead of doing the action yourself or just promising to remember — the automation does the work when it fires. Reference only tools that exist in your toolset and host events you have been told about. create_automation pauses for the user\'s approval (spoken yes or a tap) before it turns on.";

function buildInstructions(productName: string, tools: VoiceToolDef[], extras: string[], automations = false): string {
  return buildVoiceInstructions({
    persona: [
      `You are ${productName}'s voice assistant. Warm, brisk, and plain-spoken.`,
      `Use the available tools to help the user operate ${productName}; tool results are the source of truth.`,
    ].join(" "),
    toolSummary: capabilitySummary(voiceToolSummary(tools)),
    extras: [
      "Use English (US) by default unless the user explicitly switches languages.",
      "Never claim something is on screen without calling a show_* tool first.",
      ...(automations ? [AUTOMATION_VOICE_GUIDANCE] : []),
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

export interface DisposableVoiceDriver extends VoiceDriver {
  dispose(): void;
}

function inertHandle(): VoiceDriverHandle {
  return {
    mute() {},
    end() {},
    approve() {},
    decline() {},
    stop() {},
  };
}

export function createVendoVoice(options: CreateVendoVoiceOptions = {}): DisposableVoiceDriver {
  const basePath = options.basePath ?? "/api/vendo";
  const internals = createVoiceInternals(options);
  const activeStops = new Set<() => void>();
  let disposed = false;
  return {
    dispose() {
      disposed = true;
      for (const stop of [...activeStops]) stop();
      internals.dispose();
    },
    start(emit, init) {
      internals.clearResults();
      if (disposed) return inertHandle();

      let inner: VoiceDriverHandle | null = null;
      let stopped = false;
      let unregisterSessionTools = () => {};
      const queued: Array<(handle: VoiceDriverHandle) => void> = [];
      const withInner = (fn: (handle: VoiceDriverHandle) => void) => {
        if (inner) fn(inner);
        else queued.push(fn);
      };
      const cleanup = () => {
        activeStops.delete(stop);
        unregisterSessionTools();
        unregisterSessionTools = () => {};
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        inner?.stop();
        cleanup();
      };
      activeStops.add(stop);

      emit({ type: "status", status: "connecting" });
      void Promise.allSettled([getSession(basePath), internals.createIntegrationVoiceTools()] as const)
        .then(([grantResult, integrationResult]) => {
          const integration =
            integrationResult.status === "fulfilled"
              ? integrationResult.value
              : { tools: [], unregister() {} };
          unregisterSessionTools = integration.unregister;
          if (grantResult.status === "rejected") throw grantResult.reason;
          if (stopped || disposed) {
            cleanup();
            return;
          }
          const sessionTools = [...internals.tools, ...integration.tools];
          const realtime = createRealtimeVoiceDriver({
            getSession: async () => grantResult.value,
            tools: sessionTools,
            instructions: internals.buildInstructions(sessionTools),
            greeting: internals.greeting,
          });
          inner = realtime.start(emit, init);
          for (const fn of queued.splice(0)) fn(inner);
        })
        .catch((error) => {
          cleanup();
          if (stopped || disposed) return;
          console.error("[vendo voice] failed to prepare realtime session", error);
          emit({
            type: "status",
            status: "error",
            message: "Voice couldn't start. Check the microphone permission and try again.",
          });
        });

      return {
        mute: (muted) => withInner((handle) => handle.mute(muted)),
        end: () => withInner((handle) => handle.end()),
        approve: (id, via) => withInner((handle) => handle.approve(id, via)),
        decline: (id) => withInner((handle) => handle.decline(id)),
        stop,
      };
    },
  };
}

/** Internal seams exported for unit tests only. */
export const __voiceTesting = { createVoiceInternals, resolvePointer, stableStringify };
