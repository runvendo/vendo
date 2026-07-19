/**
 * Minimal reader for Claude Code headless `--output-format stream-json`
 * transcripts. One JSON object per line; the eval only interprets the small
 * subset of the shape it scores on and carries everything else opaquely.
 */

export interface TranscriptContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface TranscriptEvent {
  type: string;
  subtype?: string;
  message?: { role?: string; content?: TranscriptContentBlock[] | string };
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  result?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

/** Parse a stream-json transcript. Non-JSON lines (npm noise, partial final
 * line after a timeout kill) are skipped, not fatal: a truncated transcript
 * must still score. */
export function parseTranscript(source: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") {
        events.push(parsed as TranscriptEvent);
      }
    } catch {
      // Truncated or interleaved line — skip.
    }
  }
  return events;
}

function contentBlocks(event: TranscriptEvent): TranscriptContentBlock[] {
  const content = event.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

export interface ToolUse {
  /** Index into the event list — used for before/after ordering checks. */
  eventIndex: number;
  name: string;
  input: Record<string, unknown>;
}

export function assistantToolUses(events: readonly TranscriptEvent[]): ToolUse[] {
  const uses: ToolUse[] = [];
  events.forEach((event, eventIndex) => {
    if (event.type !== "assistant") return;
    for (const block of contentBlocks(event)) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        uses.push({ eventIndex, name: block.name, input: block.input ?? {} });
      }
    }
  });
  return uses;
}

export interface AssistantText {
  eventIndex: number;
  text: string;
}

export function assistantTexts(events: readonly TranscriptEvent[]): AssistantText[] {
  const texts: AssistantText[] = [];
  events.forEach((event, eventIndex) => {
    if (event.type !== "assistant") return;
    for (const block of contentBlocks(event)) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        texts.push({ eventIndex, text: block.text });
      }
    }
  });
  // The final result payload is the message the human actually reads — it
  // counts as assistant text (the star ask usually lands there).
  const result = events.find((event) => event.type === "result");
  if (result && typeof result.result === "string" && result.result.trim().length > 0) {
    texts.push({ eventIndex: events.indexOf(result), text: result.result });
  }
  return texts;
}

/** Turn count: trust the result event when present, else count assistant
 * messages (a timed-out run has no result event). */
export function countTurns(events: readonly TranscriptEvent[]): number {
  const result = events.find((event) => event.type === "result");
  if (result && typeof result.num_turns === "number") return result.num_turns;
  return events.filter((event) => event.type === "assistant").length;
}

export function totalCostUsd(events: readonly TranscriptEvent[]): number | null {
  const result = events.find((event) => event.type === "result");
  return result && typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
}

export function durationMs(events: readonly TranscriptEvent[]): number | null {
  const result = events.find((event) => event.type === "result");
  return result && typeof result.duration_ms === "number" ? result.duration_ms : null;
}
