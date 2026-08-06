/**
 * What a thread remembers about its own size, and when that size is a problem.
 *
 * Three small pieces, one job: keep a long conversation inside the model's window
 * without anybody having to notice. The state codec is what survives between
 * turns; the estimate is how big the loop believes this turn's prompt is; the
 * trigger is the line it must not cross.
 *
 * The estimate is a HYBRID, and that is the whole idea. Every turn ends with the
 * provider telling us exactly what the prompt cost (`finish-step`'s
 * `usage.inputTokens`, cache reads included), so re-guessing that same prefix at
 * four characters per token throws away a measurement already paid for. The guess
 * is for the DELTA only — the messages the provider has not seen yet. Ported from
 * pi-mono (`packages/agent/src/harness/compaction/compaction.ts`, MIT, Mario
 * Zechner), whose estimator carries the reported count forward for exactly this
 * reason.
 *
 * No tokenizer: a per-provider vocabulary is megabytes, is wrong for every model
 * it was not built for, and would have to load before the first turn. Four
 * characters per token is within a few percent of every BPE tokenizer on English
 * prose and JSON, and the trigger sits at 81% precisely so an estimate can be a
 * few percent wrong without costing anyone a turn.
 */
import { asSchema, type ModelMessage, type ToolSet } from "ai";

export interface CompactionState {
  version: 1;
  summary?: string;
  /** `id` of the newest transcript message the summary covers. */
  coveredThroughMessageId?: string;
  /** Provider-reported prompt tokens on the LAST step of the turn that wrote this. */
  lastPromptTokens?: number;
}

/**
 * Decode the thread's slot.
 *
 * The slot is opaque by contract (`turn.state`, build contract §1.3) and can hold
 * anything: a string written by a future version of this file, a foreign
 * harness's native session id, half a row a store lost. Every one of those reads
 * as "no state" rather than as a shape the loop then trusts — losing the state
 * costs one un-compacted turn, and trusting a bad one costs a prompt nobody can
 * predict.
 */
export function readCompactionState(slot: string | undefined): CompactionState | undefined {
  if (slot === undefined || slot === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slot);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const raw = parsed as Record<string, unknown>;
  // An unknown version is a shape this build has never seen. There is nothing to
  // migrate from and nothing to guess at.
  if (raw["version"] !== 1) return undefined;
  const summary = raw["summary"];
  const covered = raw["coveredThroughMessageId"];
  const lastPromptTokens = raw["lastPromptTokens"];
  return {
    version: 1,
    ...(typeof summary === "string" ? { summary } : {}),
    ...(typeof covered === "string" ? { coveredThroughMessageId: covered } : {}),
    ...(typeof lastPromptTokens === "number" ? { lastPromptTokens } : {}),
  };
}

export function writeCompactionState(state: CompactionState): string {
  return JSON.stringify(state);
}

/**
 * Ported from cline `sdk/packages/core/src/extensions/context/compaction-shared.ts:15,17`
 * (Apache-2.0): `CONTEXT_WINDOW_INPUT_RATIO = 0.9` × `COMPACTION_TRIGGER_RATIO = 0.9`.
 *
 * Two multiplied margins, and both are load-bearing. The first keeps the ANSWER's
 * room: a prompt that fills the window leaves nowhere for the model to reply. The
 * second is the compaction headroom: the summarizer pass itself is a call against
 * the same window, so a trigger that waits for the window to be full has already
 * lost — the turn that discovers the problem is the turn that 400s.
 */
export const TRIGGER_RATIO = 0.81;

/**
 * Ported from cline `sdk/packages/core/src/extensions/context/compaction-shared.ts:19`
 * (Apache-2.0): the verbatim tail a compaction always preserves.
 *
 * Declared here with the ratio it belongs beside; the cut point that reads it
 * arrives with the summarizer.
 */
export const PRESERVE_RECENT_TOKENS = 20_000;

/** The ceiling on one summarizer pass. Declared here, read by the summarizer. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 2_000;

export interface CompactionConfig {
  contextWindowTokens: number;
  triggerRatio?: number;
  preserveRecentTokens?: number;
}

/** Prompt tokens per character — see the file header for why this is an estimate
 *  and not a tokenizer. The shed keeps its own copy (`loop.ts`'s
 *  `CHARS_PER_TOKEN`) because it measures a different thing: the messages it may
 *  drop, never the system prompt or the tools block it cannot. */
const CHARS_PER_TOKEN = 4;

const tokensFor = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

const messageChars = (messages: readonly ModelMessage[]): number =>
  messages.reduce((chars, message) => chars + JSON.stringify(message).length, 0);

/**
 * The tools block, counted.
 *
 * Ported from cline `compaction.ts:300-304` (Apache-2.0), which counts the tool
 * definitions into the same estimate as the messages. It is not a rounding error:
 * a curated deployment sends every equipped tool's name, description and JSON
 * schema on EVERY step, routinely tens of thousands of tokens, and unlike the
 * messages it never shrinks. An estimate that omits it is an estimate of part of
 * the prompt.
 */
function toolsBlockChars(tools: ToolSet): number {
  return Object.entries(tools).reduce((chars, [name, entry]) => {
    // A schema built lazily resolves to a promise, which stringifies to `{}` —
    // an undercount for a shape the provider has not been handed either.
    const inputSchema = asSchema(entry.inputSchema as never).jsonSchema;
    return chars + JSON.stringify({ name, description: entry.description, inputSchema }).length;
  }, 0);
}

export function estimatePromptTokens(input: {
  system: string;
  messages: readonly ModelMessage[];
  tools: ToolSet;
  lastPromptTokens?: number;
  /** How many of `messages` that number already covers. */
  reportedThrough?: number;
}): number {
  const { system, messages, tools, lastPromptTokens, reportedThrough } = input;
  if (lastPromptTokens === undefined) {
    return tokensFor(system.length + messageChars(messages) + toolsBlockChars(tools));
  }
  // The provider's number already covers the system prompt and the tools block
  // it was sent with, so only the messages it has not seen are added to it.
  const covered = Math.min(Math.max(reportedThrough ?? 0, 0), messages.length);
  return lastPromptTokens + tokensFor(messageChars(messages.slice(covered)));
}

/** The estimate at which a turn must act. */
export function triggerTokens(config: CompactionConfig): number {
  return Math.floor(config.contextWindowTokens * (config.triggerRatio ?? TRIGGER_RATIO));
}

export function shouldCompact(promptTokens: number, config: CompactionConfig): boolean {
  return promptTokens >= triggerTokens(config);
}
