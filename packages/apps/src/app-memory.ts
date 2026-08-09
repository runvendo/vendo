/**
 * The app's memory: the caps that keep it small, and the block every editor
 * reads before the document itself.
 *
 * The type is core's ({@link AppMemory}); the POLICY is here, because a cap is a
 * write-site decision and a stored document must still parse when the cap
 * changes. One module so the runtime's write door and the two briefs that read
 * it cannot disagree about what "the memory" is.
 */
import type { AppMemory } from "@vendoai/core";

/**
 * How many asks a row keeps. Twenty is the point past which an ask is history
 * rather than context — the oldest is dropped, so the memory stays a working
 * set instead of growing without bound on a long-lived app.
 */
export const APP_MEMORY_MAX_ASKS = 20;

/**
 * The decisions budget. ~5 lines fits well inside this; the cap exists so a
 * model that ignores "keep it short" cannot put a transcript in every future
 * prompt.
 */
export const APP_MEMORY_DECISIONS_MAX_BYTES = 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The ellipsis is part of the budget, so a truncated block is still within it. */
const ELLIPSIS = "…";

const truncate = (value: string): string => {
  const bytes = encoder.encode(value);
  if (bytes.length <= APP_MEMORY_DECISIONS_MAX_BYTES) return value;
  const room = APP_MEMORY_DECISIONS_MAX_BYTES - encoder.encode(ELLIPSIS).length;
  // The cut can land mid-codepoint; the decoder emits U+FFFD for the partial
  // tail, and dropping it is what keeps the truncation valid text.
  return `${decoder.decode(bytes.slice(0, room)).replace(/\uFFFD$/, "")}${ELLIPSIS}`;
};

/**
 * The memory after one run: the ask APPENDED, the decisions REPLACED.
 *
 * The asymmetry is the whole design. An ask is what the person actually said and
 * is true forever; a decisions block describes the app as it stands, so keeping
 * the previous one beside it would present a superseded constraint as a current
 * one. An empty or whitespace-only `decisions` is "nothing to say", not "forget
 * what you knew".
 */
export const rememberedMemory = (
  memory: AppMemory | undefined,
  input: { ask?: string; decisions?: string },
): AppMemory => {
  const asks = [...(memory?.asks ?? []), ...(input.ask === undefined ? [] : [input.ask])];
  const decisions = input.decisions === undefined || input.decisions.trim() === ""
    ? memory?.decisions
    : truncate(input.decisions);
  return {
    asks: asks.slice(-APP_MEMORY_MAX_ASKS),
    ...(decisions === undefined ? {} : { decisions }),
  };
};

/**
 * The memory as a brief opens with it, or `undefined` when there is nothing to
 * say.
 *
 * It leads the prompt rather than trailing the document, because it is what the
 * document CANNOT say: the reader is about to see a filtered list and needs to
 * know the filter was the ask before deciding it is a bug.
 */
export const appMemoryBrief = (memory: AppMemory | undefined): string | undefined => {
  const asks = memory?.asks ?? [];
  const decisions = memory?.decisions?.trim();
  if (asks.length === 0 && (decisions === undefined || decisions === "")) return undefined;
  return [
    "THIS APP'S MEMORY — read it before the app itself. It is what the document cannot tell you.",
    ...(asks.length === 0 ? [] : [`EVERY ASK THAT SHAPED IT, oldest first:\n${asks.map((ask) => `- ${ask}`).join("\n")}`]),
    ...(decisions === undefined || decisions === ""
      ? []
      : [`DECISIONS ON RECORD (choices made, constraints found, things ruled out):\n${decisions}`]),
  ].join("\n\n");
};
