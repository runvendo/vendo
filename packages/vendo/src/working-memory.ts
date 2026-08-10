/**
 * Working memory — the agent's own small, always-in-prompt scratchpad.
 *
 * Ported from Mastra's schema-mode working memory
 * (https://mastra.ai/docs/memory/working-memory): a bounded structured state
 * that lives OUTSIDE the message history, rides the system message every turn,
 * and is updated by ONE dedicated tool with merge semantics — only the fields
 * the model sends change, and an explicit `null` deletes a key. It is not a
 * summarizer: nothing here compresses or rewrites the transcript.
 *
 * What it is FOR, in the resident loop: a figure stated on turn 1 and referred
 * to as "that one" on turn 4 otherwise has to be re-derived by re-reading the
 * thread or re-calling the tool that produced it. Three things go in the slot —
 * a figure just stated, the task a detour interrupted, and what a pronoun points
 * at — and the section is rendered last, so it is the freshest thing the model
 * reads.
 *
 * In-process and bounded on purpose: the harness runtime's own default state
 * store is in-memory too (`memoryHarnessStateStore()`), and the durable version
 * belongs in the harness's own state string. It deliberately does NOT reuse
 * `harnessStateStore`, which keeps ONE row per thread keyed by harness name — a
 * second name there would wipe the harness's compaction slot.
 *
 * The cost is prompt cache: the system message carries the cache breakpoint, so
 * a changed block re-bills the cached system prefix for that turn. That is
 * affordable against the RESIDENT prompt (~5k chars) and must never be added to
 * the screen writer's briefing pack, where the re-bill would dominate.
 */
import type { RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";

/** Not `vendo_`-prefixed, and that is deliberate: the model reads its human
 *  title, and the bench's tool budget counts the WORLD's tools, not ours. */
const REMEMBER_TOOL = "remember";

/** The human title, which is the only name the model is ever told to say. */
const TITLE = "Keep this in mind";

/** What one session holds. Values are single-line and short by construction:
 *  this section is joined into the system prompt like any other, so a value
 *  carrying a line break could forge a section header (the same reason core's
 *  prompt blocks indent host-supplied text). `null` is a wire value meaning
 *  "delete"; nothing is ever stored as null. */
interface WorkingMemory {
  figures?: Record<string, string>;
  pending?: string;
  referents?: Record<string, string>;
}

/** Bounds, all three of them small — a scratchpad that can grow is a second
 *  transcript, and this one is re-billed against the prompt cache every time it
 *  changes. */
const MAX_SESSIONS = 200;
const MAX_ENTRIES = 12;
const MAX_VALUE_CHARS = 200;

const SLOTS = new Map<string, WorkingMemory>();

/** One line, always. This section is joined into the system prompt like any
 *  other, and a value carrying a blank line is indistinguishable from a
 *  section the assembler wrote itself — the forgery core's prompt blocks
 *  indent against. Short, too: the slot is re-billed against the prompt cache
 *  every time it changes. */
const oneLine = (value: string): string =>
  value.replace(/\s+/gu, " ").trim().slice(0, MAX_VALUE_CHARS);

const asPatch = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

/**
 * Mastra's merge, for one map field: the keys the model sent update, a `null`
 * deletes, everything else is left alone. Past the cap the OLDEST entry drops —
 * insertion order is the Map's, and updating an existing key keeps its place.
 */
function mergeEntries(
  current: Record<string, string> | undefined,
  patch: Record<string, unknown>,
): Record<string, string> | undefined {
  const entries = new Map(Object.entries(current ?? {}));
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = oneLine(rawKey);
    if (key === "") continue;
    if (value === null) {
      entries.delete(key);
    } else if (typeof value === "string" || typeof value === "number") {
      // Numbers are accepted because a model asked for a figure sends one.
      entries.set(key, oneLine(String(value)));
    }
  }
  if (entries.size === 0) return undefined;
  return Object.fromEntries([...entries].slice(-MAX_ENTRIES));
}

/** Write the slot back, bounded: past the cap the oldest SESSION drops. */
function store(sessionId: string, memory: WorkingMemory): void {
  SLOTS.delete(sessionId);
  SLOTS.set(sessionId, memory);
  if (SLOTS.size > MAX_SESSIONS) {
    const oldest = SLOTS.keys().next();
    if (oldest.done !== true) SLOTS.delete(oldest.value);
  }
}

const DESCRIPTOR: ToolDescriptor = {
  name: REMEMBER_TOOL,
  title: TITLE,
  description:
    "Update the short note you carry in every turn's instructions, so you never have to re-derive "
    + "something you already worked out: figures for a number you just stated "
    + "({\"total across accounts\": \"$36,265.15\"}), pending for the task a detour interrupted, "
    + "referents for what a pronoun points at ({\"that one\": \"tr_2\"}). Only the fields you send "
    + "change and null deletes one, so send just what moved. Call it alongside your other work when "
    + "one of those actually changes — never as a step of its own before answering.",
  inputSchema: {
    type: "object",
    properties: {
      figures: {
        type: "object",
        description: "A figure you stated, keyed by what it measures. null drops the key.",
        additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      pending: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "The task a detour interrupted, in your own words. null clears it.",
      },
      referents: {
        type: "object",
        description: "What a pronoun refers to, keyed by the words the user used. null drops the key.",
        additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
    additionalProperties: false,
  },
  risk: "read",
};

/**
 * The `remember` door as a one-tool registry, composed beside `ask_user` so the
 * guard, the audit trail and `find_tools` see it like any other tool.
 *
 * It is a `read` because keeping a note costs no authority: §12's "reads are
 * silent, always", so it never spends a grant or raises a consent card.
 */
export function workingMemoryRegistry(): ToolRegistry {
  return {
    async descriptors() {
      return [DESCRIPTOR];
    },

    async execute(call, ctx: RunContext) {
      const args = (call.args ?? {}) as { figures?: unknown; pending?: unknown; referents?: unknown };
      const current = SLOTS.get(ctx.sessionId) ?? {};
      // Only what arrived changes: a field the model left out is not a deletion,
      // and a field that is not an object at all is not a patch.
      const patched = (
        entries: Record<string, string> | undefined,
        patch: unknown,
      ): Record<string, string> | undefined => {
        const fields = asPatch(patch);
        return fields === undefined ? entries : mergeEntries(entries, fields);
      };
      const figures = patched(current.figures, args.figures);
      const referents = patched(current.referents, args.referents);
      const pending = args.pending === undefined
        ? current.pending
        : (args.pending === null ? undefined : oneLine(String(args.pending)) || undefined);
      const next: WorkingMemory = {
        ...(figures === undefined ? {} : { figures }),
        ...(pending === undefined ? {} : { pending }),
        ...(referents === undefined ? {} : { referents }),
      };
      store(ctx.sessionId, next);
      // The WHOLE resulting note comes back, so the model can see what it now
      // holds rather than guess at the merge.
      return { status: "ok", output: { memory: next } };
    },
  };
}

/**
 * The slot as a prompt section, or `undefined` when there is nothing in it —
 * `assembleSystemPrompt` pushes it LAST, after the deployment's instructions.
 */
export function workingMemoryBlock(ctx: RunContext): string | undefined {
  const memory = SLOTS.get(ctx.sessionId);
  if (memory === undefined) return undefined;
  const lines: string[] = [];
  const pairs = (label: string, entries: Record<string, string> | undefined): void => {
    const rendered = Object.entries(entries ?? {}).map(([key, value]) => `${key} = ${value}`);
    if (rendered.length > 0) lines.push(`- ${label}: ${rendered.join("; ")}`);
  };
  pairs("figures", memory.figures);
  if (memory.pending !== undefined) lines.push(`- pending: ${memory.pending}`);
  pairs("referents", memory.referents);
  if (lines.length === 0) return undefined;
  return [`Working memory (yours; update it with "${TITLE}")`, ...lines].join("\n");
}
