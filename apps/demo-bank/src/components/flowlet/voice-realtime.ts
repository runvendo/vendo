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
import { executeHostToolCall, type UINode } from "@flowlet/core";
import { mapleHostToolDefs } from "@/flowlet/host-tools";
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

/** Demo-fiction critical action: Maple's API has no money movement, but the
 *  critical consent register needs a live representative. */
const demoTransferTool: VoiceToolDef = {
  name: "transfer_funds",
  description:
    "Move money between the user's accounts. Requires the user's ON-SCREEN confirmation — never a spoken yes.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      amount: { type: "string", description: "e.g. $87.00" },
    },
    required: ["from", "to", "amount"],
  },
  tier: "critical",
  execute: async (input) => ({ transferred: true, ...(input as Record<string, unknown>) }),
  toView: (input) => {
    const { from, to, amount } = (input ?? {}) as Record<string, string>;
    return keyValueView({
      title: "Transfer complete",
      rows: [
        { label: "From", value: from ?? "—" },
        { label: "To", value: to ?? "—" },
        { label: "Amount", value: amount ?? "—", emphasis: true },
        { label: "When", value: "Instant" },
      ],
    });
  },
};

/** Every Maple host-API operation, straight through the chat-side executor. */
const hostVoiceTools: VoiceToolDef[] = mapleHostToolDefs.map((def) => ({
  name: def.name,
  description: def.description,
  parameters: def.inputSchema,
  tier: annotationsToTier(def.annotations),
  execute: (input) => executeHostToolCall(def, (input ?? {}) as Record<string, unknown>),
}));

const INSTRUCTIONS = [
  "You are Maple's voice assistant — Maple is the user's bank. Warm, brisk, plain-spoken.",
  "You can read the user's real accounts, transactions, cards, insights and payees through your tools; the data comes back as JSON from Maple's own API.",
  "Money amounts in the API are integer CENTS — always convert and display as dollars (941220 → $9,412.20), on screen and aloud.",
  "When data is worth seeing, put it on screen with show_table or show_key_value and speak only the headline (totals, the outlier, what to do next). Never read rows aloud.",
  "Keep spoken turns to one or two sentences.",
].join(" ");

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
        const grant = (await res.json()) as { clientSecret: string; model?: string };
        if (stopped) return;
        const driver = createRealtimeVoiceDriver({
          getSession: async () => grant,
          tools: [...displayTools, demoTransferTool, ...hostVoiceTools],
          instructions: INSTRUCTIONS,
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
