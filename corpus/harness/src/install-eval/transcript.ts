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
  // Result payloads are the messages the human actually reads — they count
  // as assistant text (the star ask usually lands in the LAST one; a
  // scripted-human run has one result event per invocation).
  events.forEach((event, eventIndex) => {
    if (event.type === "result" && typeof event.result === "string" && event.result.trim().length > 0) {
      texts.push({ eventIndex, text: event.result });
    }
  });
  return texts.sort((a, b) => a.eventIndex - b.eventIndex);
}

/** Split a transcript into per-invocation segments. Each `claude` invocation
 * (the initial `-p` run and any scripted-human `--resume` continuation, which
 * appends to the same transcript file) opens with a `system/init` event. */
export function invocationSegments(events: readonly TranscriptEvent[]): TranscriptEvent[][] {
  if (events.length === 0) return [];
  const segments: TranscriptEvent[][] = [];
  let current: TranscriptEvent[] = [];
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init" && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(event);
  }
  segments.push(current);
  return segments;
}

/** The last thing the human would have read from one invocation: the result
 * payload when present, else the last assistant text (timed-out runs have no
 * result event). */
export function finalAssistantText(events: readonly TranscriptEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "result" && typeof event.result === "string" && event.result.trim().length > 0) {
      return event.result;
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "assistant") continue;
    const blocks = contentBlocks(event);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]!;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        return block.text;
      }
    }
  }
  return null;
}

/** Turn count, summed across invocations: per segment trust the result event
 * when present, else count assistant messages (a timed-out invocation has no
 * result event). A scripted-human continuation therefore spends from the SAME
 * turn budget as the first invocation. */
export function countTurns(events: readonly TranscriptEvent[]): number {
  return invocationSegments(events).reduce((sum, segment) => {
    const result = segment.find((event) => event.type === "result");
    if (result && typeof result.num_turns === "number") return sum + result.num_turns;
    return sum + segment.filter((event) => event.type === "assistant").length;
  }, 0);
}

function sumResultField(events: readonly TranscriptEvent[], field: "total_cost_usd" | "duration_ms"): number | null {
  const values = events
    .filter((event) => event.type === "result")
    .map((event) => event[field])
    .filter((value): value is number => typeof value === "number");
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

/** Total cost, summed across invocations (each result event reports its own
 * invocation's spend). */
export function totalCostUsd(events: readonly TranscriptEvent[]): number | null {
  return sumResultField(events, "total_cost_usd");
}

export function durationMs(events: readonly TranscriptEvent[]): number | null {
  return sumResultField(events, "duration_ms");
}
