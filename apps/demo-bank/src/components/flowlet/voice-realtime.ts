/**
 * Maple's REALTIME voice wiring (ENG-185): the same host-API tool definitions
 * chat uses, adapted for the voice agent — executed in the browser on the
 * user's session (topology B), gated by the same annotation-derived tiers,
 * with two display tools so the agent can put views on the stage.
 *
 * Falls back to the scripted choreography when the host has no
 * OPENAI_API_KEY (the /api/flowlet/voice endpoint answers 503) — the mic
 * always does something sensible.
 */
import {
  annotationsToTier,
  createRealtimeVoiceDriver,
  type VoiceDriver,
  type VoiceDriverHandle,
  type VoiceEvent,
  type VoiceToolDef,
} from "@flowlet/shell";
import {
  buildVoiceInstructions,
  capabilitySummary,
  executeHostToolCall,
  type ToolSummaryInput,
  type UINode,
} from "@flowlet/core";
import { mapleHostToolDefs } from "@/flowlet/host-tools";
import { createComposioIntegrations, integrationCatalogIds } from "./integrations";
import { mapleVoiceDriver as scriptedFallback } from "./voice-demo";

let viewSeq = 0;

/** Wrap rows/columns from the model into a sandbox-rendered Table view. */
function tableView(input: unknown): UINode | undefined {
  const { title, columns, rows } = (input ?? {}) as {
    title?: string;
    columns?: Array<{ key: string; label: string }>;
    rows?: Array<Record<string, unknown>>;
  };
  if (!columns?.length || !rows) return undefined;
  return {
    id: `voice-table-${++viewSeq}`,
    kind: "generated",
    payload: {
      formatVersion: "flowlet-genui/v1",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: title ? ["title", "table"] : ["table"] },
        ...(title ? [{ id: "title", component: "Text", props: { value: title } }] : []),
        { id: "table", component: "Table", source: "prewired", props: { columns, rows } },
      ],
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
      formatVersion: "flowlet-genui/v1",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["kv"] },
        { id: "kv", component: "KeyValue", source: "prewired", props: { title, rows } },
      ],
    },
  };
}

const displayTools: VoiceToolDef[] = [
  {
    name: "show_table",
    description:
      "Display structured rows (transactions, comparisons) as a table on screen. Use this to SHOW data — then speak only the headline.",
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

/** Every Maple host-API operation, straight through the chat-side executor. */
const hostVoiceTools: VoiceToolDef[] = mapleHostToolDefs.map((def) => ({
  name: def.name,
  description: def.description,
  parameters: def.inputSchema,
  tier: annotationsToTier(def.annotations),
  execute: (input) => executeHostToolCall(def, (input ?? {}) as Record<string, unknown>),
}));

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
 *  consent recency, guardrails) come from @flowlet/core; only the persona and
 *  the cents convention are Maple's. Assembled at session start so the
 *  capability summary reflects the LIVE tool list. */
function buildInstructions(tools: VoiceToolDef[]): string {
  return buildVoiceInstructions({
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
    const res = await fetch("/api/flowlet/voice/tools");
    if (!res.ok) return [];
    const body = (await res.json()) as {
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown>; tier: string }>;
    };
    return (body.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      tier: tool.tier === "read" ? "read" : tool.tier === "critical" ? "critical" : "act",
      execute: async (input) => {
        const exec = await fetch("/api/flowlet/voice/tools", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool: tool.name, input }),
        });
        const json = (await exec.json()) as { result?: unknown; error?: string };
        if (!exec.ok) throw new Error(json.error ?? `integration tool failed (${exec.status})`);
        return json.result;
      },
    }));
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
  start(emit: (event: VoiceEvent) => void): VoiceDriverHandle {
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

    emit({ type: "status", status: "connecting" });
    void fetch("/api/flowlet/voice", { method: "POST" })
      .then(async (res) => {
        if (stopped) return;
        if (!res.ok) {
          console.info("[flowlet voice] no realtime key — running the scripted demo session");
          adopt(scriptedFallback.start(emit));
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
        adopt(driver.start(emit));
      })
      .catch(() => {
        if (stopped) return;
        adopt(scriptedFallback.start(emit));
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
