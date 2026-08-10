/** Reading the workbench feed. Every value here is derived from parts the
 *  harness actually sent — nothing is filled in, and a fact the feed does not
 *  carry (a model name, a cost) simply has no row in the pane. */
import type { WorkbenchEvent, WorkbenchPart } from "@vendoai/ui";

export type Tone = "ok" | "warn" | "bad" | "info" | "sys" | "mute";

/** Parts of one step, gathered: `step-start`, its `tool` calls, `step-end`.
 *  Everything else stands on its own line in the timeline. */
export type Row =
  | { kind: "step"; agent: WorkbenchPart["agent"]; step: number; parts: WorkbenchPart[] }
  | { kind: "event"; part: WorkbenchPart };

export type Of<K extends WorkbenchEvent["kind"]> = WorkbenchPart & { event: Extract<WorkbenchEvent, { kind: K }> };

/** A step belongs to the loop that took it. The resident, the screen agent and a
 *  hire share one turn and one channel, and each counts its own steps from zero —
 *  so the step NUMBER alone names three different steps. */
const stepKey = (part: WorkbenchPart, step: number): string => `${part.agent}:${step}`;

export function eventsOf<K extends WorkbenchEvent["kind"]>(
  parts: readonly WorkbenchPart[],
  kind: K,
): Of<K>[] {
  return parts.filter((part): part is Of<K> => part.event.kind === kind);
}

export function rows(parts: readonly WorkbenchPart[]): Row[] {
  const out: Row[] = [];
  const steps = new Map<string, Extract<Row, { kind: "step" }>>();
  for (const part of parts) {
    if (!("step" in part.event)) {
      out.push({ kind: "event", part });
      continue;
    }
    const { step } = part.event;
    const key = stepKey(part, step);
    let group = steps.get(key);
    if (group === undefined) {
      group = { kind: "step", agent: part.agent, step, parts: [] };
      steps.set(key, group);
      out.push(group);
    }
    group.parts.push(part);
  }
  return out;
}

/** The latest window reading EACH agent took, in the order the agents first
 *  measured. A window is a fact about one loop's seat: the screen agent's 200k
 *  reading says nothing about the resident's 32k one, and reading the last one on
 *  the wire just reports whichever loop happened to measure most recently. */
export function contextByAgent(parts: readonly WorkbenchPart[]): Of<"context">[] {
  const latest = new Map<WorkbenchPart["agent"], Of<"context">>();
  for (const part of eventsOf(parts, "context")) latest.set(part.agent, part);
  return [...latest.values()];
}

export interface TurnStatus {
  running: boolean;
  step?: number;
  maxSteps?: number;
  elapsedMs: number;
  agents: WorkbenchPart["agent"][];
  outcome?: { label: string; tone: Tone };
  /** One reading per agent that measured its window — see {@link contextByAgent}. */
  contexts: Of<"context">[];
}

/** How long a quiet feed still counts as work in progress. A turn's first facts —
 *  the window reading, the summarizer's compaction — land BEFORE step 0 opens, so
 *  there is no step boundary to read yet and "no open step" is not the same thing
 *  as "over". Recency is what separates the two, and once a step has closed the
 *  boundaries are authoritative again. */
const RECENT_MS = 2_000;

export function turnStatus(parts: readonly WorkbenchPart[], now = Date.now()): TurnStatus {
  const starts = eventsOf(parts, "step-start");
  const ended = new Set(eventsOf(parts, "step-end").map(part => stepKey(part, part.event.step)));
  const last = starts.at(-1);
  const error = eventsOf(parts, "error").at(-1);
  const limit = eventsOf(parts, "step-limit").at(-1);
  const latest = parts.at(-1);
  const running = starts.some(part => !ended.has(stepKey(part, part.event.step)))
    || (ended.size === 0 && latest !== undefined && now - latest.at < RECENT_MS);
  return {
    running,
    ...(last === undefined ? {} : { step: last.event.step, maxSteps: last.event.maxSteps }),
    elapsedMs: parts.length === 0 ? 0 : parts[parts.length - 1]!.at - parts[0]!.at,
    agents: [...new Set(parts.map(part => part.agent))],
    ...(error !== undefined
      ? { outcome: { label: error.event.code, tone: "bad" as const } }
      : limit !== undefined
        ? { outcome: { label: "step limit", tone: "warn" as const } }
        : running
          ? {}
          : { outcome: { label: "settled", tone: "ok" as const } }),
    contexts: contextByAgent(parts),
  };
}

export const TONES: Record<WorkbenchEvent["kind"], Tone> = {
  "step-start": "mute",
  "step-end": "mute",
  tool: "mute",
  context: "info",
  compaction: "sys",
  shed: "warn",
  loadout: "info",
  subagent: "sys",
  error: "bad",
  "step-limit": "warn",
};

/** One line for the raw feed and for the timeline's standalone rows. */
export function describe(event: WorkbenchEvent): string {
  switch (event.kind) {
    case "step-start":
      return `step ${event.step} of ${event.maxSteps} · ${event.activeTools.length} ${event.activeTools.length === 1 ? "tool" : "tools"} active`;
    case "step-end":
      return `${event.stopReason} · ${duration(event.durationMs)}`;
    case "tool":
      return `${event.name} ${event.status} · ${duration(event.durationMs)}`;
    case "context":
      return `${count(event.estTokens)} / ${count(event.windowTokens)} tok · trigger ${count(event.triggerTokens)}`;
    case "compaction":
      return `fired on ${event.reason} · summary ${event.summary.split("\n").length} lines`;
    case "shed":
      return `shed ${event.dropped} tool ${event.dropped === 1 ? "result" : "results"}`;
    case "loadout":
      return `${event.active.length} active · ${event.withheldCount} withheld`;
    case "subagent":
      return `${event.label} · ${event.steps} of ${event.maxSteps} steps`;
    case "error":
      return `${event.code} — ${event.message}`;
    case "step-limit":
      return `stopped at ${event.steps} steps`;
  }
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function share(value: number, of: number): number {
  return of <= 0 ? 0 : Math.min(100, Math.round((value / of) * 100));
}
