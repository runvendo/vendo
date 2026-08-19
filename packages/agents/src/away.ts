/**
 * The AWAY lane — one unattended turn, in two faces.
 *
 * `run()` is the one a host calls: a task in, a {@link Turn} out (the id to hand
 * a person, the events to watch, and the same `TurnResult` a chat turn answers
 * with). {@link awayRunner} is the same turn behind core's `AgentRunner` seam
 * (01-core §13), for the automations engine and the delegation tool that already
 * speak `AgentRunReport`. ONE implementation — `runTurn` in ./turn.ts, shared
 * with the chat lane; the faces differ only in the ctx they name and the shape
 * they answer in.
 *
 * An away turn is a `RunContext` at venue "automation" and presence "away" (an
 * engine firing carries its trigger's id too — the guard's away-grant lookup
 * matches on it), the sponsor's durable workspace mounted, and the caller's
 * guard-bound registry as the whole tool surface. Everything else — the audit
 * row, the transcript, the view channel — is the runtime's and the guard's,
 * inherited rather than rebuilt.
 *
 * `AgentRunReport`'s `summary` is the one narrowing left in this file: it is
 * rendered VERBATIM in the automations panel's run row, so it is a reading
 * budget. `TurnResult.text` — what `run()` answers with — is the whole reply.
 */
import { mintTurnId, type AgentRunner, type AgentRunReport, type Json, type ThreadId } from "@vendoai/core";
import type { FlexibleSchema } from "ai";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_MAX_TOOL_CALLS,
  openingThread,
  runTurn,
  startTurn,
  type AgentDeps,
  type RecordedCall,
  type TurnDeps,
  type TurnRecord,
  type Turn,
} from "./turn.js";

/** The composition an away turn runs on — a turn's composition, under the name
 *  the `AgentRunner` seam already exports. */
export type AwayRunnerDeps = TurnDeps;

export interface RunOptions<T = void> {
  /** Whose run this is — the subject every grant, workspace and audit row is
   *  scoped to. Unset, the agent runs as itself.
   *  @deprecated Name the person ONCE — `agent.forUser(subject)` — rather than
   *  on every call, and their turns, conversations and memories come with them.
   *  Still honored: a run that passes it behaves exactly as it always has. */
  as?: string;
  /** Server-trust identity facts, model-visible (`[User]`). */
  user?: Record<string, Json>;
  /** Guard/tools context. */
  context?: Record<string, unknown>;
  /** A schema for the answer. The run gets one extra tool to report through, so
   *  the typed result costs no second model call. */
  output?: FlexibleSchema<T>;
  maxToolCalls?: number;
  signal?: AbortSignal;
  /** Continue a conversation this subject already owns, instead of a fresh one. */
  threadId?: string;
}

/**
 * How much of the model's account the run record carries. `summary` is rendered
 * VERBATIM in the automations panel's run row, so this is a reading budget — a
 * few sentences someone takes in at a glance — not a storage limit.
 */
const SUMMARY_MAX_CHARS = 400;

/**
 * The label a model puts on its own closing account: "## Summary",
 * "**Summary:**", "Final summary —". The heading marks, the emphasis and the
 * punctuation after it are all part of the LABEL, never of the words it
 * introduces.
 */
const SUMMARY_LABEL = /^[#*\s]*(?:final|closing)?\s*summary[:\-—*\s]*/i;

/** Cut to the budget on a sentence boundary when there is one near it, so a
 *  narrowed summary ends on a finished thought rather than mid-word. */
function capped(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const head = text.slice(0, SUMMARY_MAX_CHARS);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return sentenceEnd > SUMMARY_MAX_CHARS / 2
    ? head.slice(0, sentenceEnd + 1)
    : `${head.trimEnd()}…`;
}

/**
 * The SUMMARY out of what the model said (01-core §13, 07-automations §5 —
 * "agentic: model-written").
 *
 * An away turn's assistant message is the whole working narration: the plan it
 * announced, every note it made on the way, and only then the account of what
 * happened. Reporting all of it made a succeeded run render thousands of
 * characters of "I'll gather all the data simultaneously… **Analysis notes:**"
 * where the panel's run row promises a line.
 *
 * A reply already inside the budget IS the summary and is left exactly as
 * written — narrowing a short answer would drop things it is the only record of.
 * A longer one is narrowed to the model's own closing account: the section it
 * MARKED as a summary if it wrote one, else its closing paragraph. Never a
 * sentence of ours — the model's words, just the right ones.
 */
function conciseSummary(spoken: string): string {
  if (spoken.length <= SUMMARY_MAX_CHARS) return spoken;
  const blocks = spoken.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block !== "");
  // The LAST label wins: a run that summarised twice ended on the later one.
  let labelled = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (SUMMARY_LABEL.test(blocks[index]!)) {
      labelled = index;
      break;
    }
  }
  const chosen = labelled === -1
    ? blocks.at(-1)
    // A label with nothing after it on its own line introduces the block BELOW it.
    : blocks[labelled]!.replace(SUMMARY_LABEL, "").trim() || blocks[labelled + 1];
  return capped((chosen ?? spoken).trim());
}

function fallbackSummary(status: AgentRunReport["status"], calls: readonly RecordedCall[]): string {
  if (status === "error") return "The run could not be completed.";
  if (status === "stopped") return "The run stopped before it was finished.";
  return `The run completed with ${calls.length} tool call${calls.length === 1 ? "" : "s"}.`;
}

/**
 * One turn as core's `AgentRunner` reads it.
 *
 * A turn that PARKED still reports `ok`: the run itself finished honestly, and a
 * card standing for a person is not a failed automation. That is why this face
 * has three statuses where a `TurnResult` has four.
 */
function asReport(record: TurnRecord): AgentRunReport {
  const status: AgentRunReport["status"] = record.stopped !== undefined
    ? "stopped"
    : record.failed !== undefined ? "error" : "ok";
  const spoken = record.failed?.message ?? conciseSummary(record.text);
  return {
    status,
    summary: spoken === "" ? fallbackSummary(status, record.toolCalls) : spoken,
    toolCalls: record.toolCalls,
  };
}

/**
 * `agent.run(task)` — one unattended turn, for code rather than a screen.
 *
 * Returned rather than awaited so the ids are readable immediately (show the
 * thread, or hand it back as `run({ threadId })`) and `events` can be read while
 * the run is still going. Cancellation is the `signal` the caller passes.
 *
 * Every ask PARKS — nobody is there to tap — so a run that needed consent
 * answers `interrupted`, with the cards on it and `resume()` to carry on.
 */
export function startRun<T = void>(deps: AgentDeps, task: string, options: RunOptions<T> = {}): Turn<T> {
  const opening = openingThread(options);
  return startTurn<T>(deps, {
    ...opening,
    prompt: task,
    ctx: {
      // Unset, the agent runs as ITSELF — the subject its own audit rows are
      // attributed to, never a borrowed user.
      principal: { kind: "user", subject: options.as ?? `vendo:agent:${deps.name}` },
      venue: "automation",
      presence: "away",
      sessionId: opening.threadId,
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.context === undefined ? {} : { context: options.context }),
    },
    turnId: mintTurnId(),
    maxToolCalls: options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.output === undefined ? {} : { output: options.output as FlexibleSchema<unknown> }),
  });
}

/**
 * The same turn behind core's `AgentRunner` seam (01-core §13) — the shape the
 * automations engine and the delegation tool already speak. Prefer
 * {@link startRun} (`agent.run`) for anything new: it is this turn with the ids,
 * the live events, the usage, the typed output and the interruptions attached.
 *
 * `AgentComposition` (what `agentComposition(agent)` returns) satisfies these deps
 * structurally, so a host that already built an `agent()` can hand its composition
 * straight in.
 */
export function awayRunner(deps: AwayRunnerDeps): AgentRunner {
  return async (task, ctx) => asReport(await runTurn(deps, {
    prompt: task.prompt,
    tools: task.tools,
    // Only presence is asserted, for an engine that came in without it.
    ctx: { ...ctx, presence: "away" },
    threadId: `thr_${randomUUID()}` as ThreadId,
    turnId: mintTurnId(),
    reopen: false,
    maxToolCalls: task.budget?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    ...(task.abortSignal === undefined ? {} : { signal: task.abortSignal }),
  }));
}
