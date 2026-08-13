/**
 * The AWAY lane — one non-interactive harness run, in two faces.
 *
 * `run()` is the one a host calls: a task in, an {@link AgentRun} out (the
 * report to await, the thread id to hand a person, the events to watch).
 * {@link awayRunner} is the same run behind core's `AgentRunner` seam (01-core
 * §13), for the automations engine and the delegation tool that already speak it.
 * ONE implementation ({@link runTurn}) — the two faces only differ in who names
 * the ctx.
 *
 * One run is one non-interactive harness run: `interactive: false`, a
 * `RunContext` at venue "automation" and presence "away" (an engine firing
 * carries its trigger's id too — the guard's away-grant lookup matches on it),
 * the sponsor's durable workspace mounted, and the caller's guard-bound registry
 * as the whole tool surface. Everything else — approvals as §1.4's wait-or-fail
 * (here: fail, with the card left standing, which is what `refs.approvals`
 * reports), the audit row, the transcript, the view channel — is the runtime's
 * and the guard's, inherited rather than rebuilt. There is no resume: a person
 * answers the cards, and the caller runs again.
 *
 * The report is assembled from the three things the run really leaves behind: the
 * shipped tool bridge's own `onCall`/`gate` rails (the calls and the outcomes the
 * guard returned), the persisted assistant message (the summary, read back
 * through the real read path and narrowed to the model's closing account), and
 * the harness's own `error` event.
 */
import {
  VendoError,
  createTurnSkills,
  hostSkillFiles,
  type AgentRunner,
  type AgentRunReport,
  type FilesAdapter,
  type Guard,
  type Harness,
  type HarnessEvent,
  type Json,
  type JsonSchema,
  type Skill,
  type RunContext,
  type SeatModels,
  type ThreadId,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
  type Turn,
} from "@vendoai/core";
import { wrapWorkspaceForRender } from "@vendoai/apps";
import { addUsage, createHarnessRuntime, type HarnessRuntimeDeps, type UsageTotals } from "@vendoai/harnesses";
import { storeFiles, threadMessageStore, workspaceStore, type VendoStore } from "@vendoai/store";
import { asSchema, type FlexibleSchema, type LanguageModel, type Schema, type UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import { resolveSystem, type SystemPromptHook } from "./prompt.js";
import { asUserMessage, openThread } from "./session.js";

/** What a caller with no budget gets. The automations engine always passes its
 *  own (50), so this only bounds a host driving the seam directly. */
const DEFAULT_MAX_TOOL_CALLS = 20;

/** What a call past the run's budget gets. Two rails answer with it: `preflight`
 *  rules the call out before the guard can park it, and `gate` — the rail whose
 *  outcome reaches the model — repeats it for that same call. */
const BUDGET_EXHAUSTED: ToolOutcome = {
  status: "error",
  error: { code: "budget-exhausted", message: "Tool-call budget exhausted" },
};

export interface AwayRunnerDeps {
  /** The brain, with its knobs already bound. */
  harness: Harness<unknown>;
  store: VendoStore;
  guard: Guard;
  /** Where workspace blobs land; unset → the store's own rows. */
  files?: FilesAdapter;
  /** Projected into the read-only `/host/skills` mount, as in a session. */
  skills?: readonly Skill[];
  /** The host's prompt block. */
  instructions?: string;
  /**
   * The run's system prompt, for a composition that already has one. Handed this
   * package's own assembly (`instructions`, the ctx's situation data, and the
   * guard's directions); a returned string is used verbatim, `undefined` is that
   * default — never a promptless run.
   *
   * It exists because the prompt is VENUE-GATED and carries the guard's
   * directions, so it needs the ctx: the umbrella assembles a chat turn's brief
   * per turn, and an away firing that thought with a different brief than a chat
   * turn would be a second agent wearing the same name.
   */
  system?: SystemPromptHook;
  /** The seats a harness that does NOT bring its own brain reads (`vendo()`). */
  models?: SeatModels<LanguageModel>;
  liveTurn?: HarnessRuntimeDeps["liveTurn"];
}

interface RecordedCall {
  call: ToolCall;
  outcome: ToolOutcome["status"];
}

/** What a caller can watch a run do while it runs. The harness's own vocabulary
 *  for what it SAYS (`text`/`status`/`error`, straight off the runtime's
 *  `observe` tap) plus the two things it DOES, off the same bridge rails the
 *  report is assembled from. */
export type RunEvent =
  | { type: "text"; delta: string }
  | { type: "status"; label: string }
  | { type: "error"; message: string }
  | { type: "tool-call"; id: string; tool: string; args: Json }
  | { type: "tool-result"; id: string; tool: string; outcome: ToolOutcome["status"] };

export interface AgentReport<T = never> extends AgentRunReport {
  refs: {
    threadId: string;
    /** Approvals this run parked. Non-empty means a person has to answer them
     *  before the work can happen — the run itself finished honestly, which is
     *  why the status is still `ok`. There is no resume: show these, then call
     *  `run()` again. */
    approvals: readonly string[];
  };
  /** Present only when `output` was asked for AND the model filled it in. */
  output?: T;
  usage: UsageTotals;
}

export interface AgentRun<T = never> extends PromiseLike<AgentReport<T>> {
  /** Available before the run starts, so a caller can show it (or hand it back
   *  as `run({ threadId })`) without waiting for the report. */
  readonly threadId: string;
  readonly events: AsyncIterable<RunEvent>;
}

export interface RunOptions<T = never> {
  /** Whose run this is — the subject every grant, workspace and audit row is
   *  scoped to. Unset, the agent runs as itself. */
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

/** The run's return channel. Named, rather than parsed back out of prose,
 *  because the args the model already assembled ARE the answer. */
const RESULT_TOOL = "vendo_result";

/**
 * The typed-output surface: one synthetic tool on THIS run's registry, whose
 * args are validated against the caller's schema.
 *
 * Deliberately OUTSIDE the guard binding. It reaches nothing — no network, no
 * host API, no file — so there is nothing for a person to approve, and an
 * unattended run whose result channel parked on an approval card would be a
 * typed run that can never return.
 */
function withResultTool(
  tools: ToolRegistry,
  schema: Schema<unknown>,
  capture: (value: unknown) => void,
): ToolRegistry {
  return {
    async descriptors(ctx) {
      return [...await tools.descriptors(ctx), {
        name: RESULT_TOOL,
        description: "Report this run's result. Call this once, with the finished answer.",
        inputSchema: schema.jsonSchema as JsonSchema,
        risk: "read",
      }];
    },
    async execute(call, ctx) {
      if (call.tool !== RESULT_TOOL) return tools.execute(call, ctx);
      const checked = await schema.validate?.(call.args) ?? { success: true as const, value: call.args };
      if (!checked.success) {
        // Back to the MODEL, in its own error channel, so it can fix the shape
        // and call again rather than the run failing on a fixable mistake.
        return { status: "error", error: { code: "validation", message: checked.error.message } };
      }
      capture(checked.value);
      return { status: "ok", output: { recorded: true } };
    },
  };
}

/** One buffer, one waiter — everything an `AsyncIterable` fed from callbacks
 *  needs. A caller that never reads `events` costs the run nothing but the
 *  buffer. */
function eventQueue<T>(): { push: (item: T) => void; close: () => void; iterable: AsyncIterable<T> } {
  const buffered: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const nudge = (): void => {
    wake?.();
    wake = undefined;
  };
  return {
    push: (item) => {
      buffered.push(item);
      nudge();
    },
    close: () => {
      closed = true;
      nudge();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (buffered.length > 0) yield buffered.shift() as T;
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

function fallbackSummary(status: AgentRunReport["status"], calls: readonly RecordedCall[]): string {
  if (status === "error") return "The run could not be completed.";
  if (status === "stopped") return "The run stopped before it was finished.";
  return `The run completed with ${calls.length} tool call${calls.length === 1 ? "" : "s"}.`;
}

/**
 * Watch the harness's own closed vocabulary for a failure, without taking
 * anything away from the runtime.
 *
 * A harness `error` event reaches the SCREEN's error channel and never the
 * transcript (runtime.ts), so it is invisible to a caller that only reads the
 * persisted turn — and "the nightly digest failed" reported as a successful run is
 * the failure this whole seam exists to avoid. A throw is left to propagate: the
 * runtime's own handler already puts its plain sentence in the transcript, so only
 * the STATUS is missing here.
 *
 * Wrapping is safe: the adapter slots a harness reads (`harnessAdapters`) are
 * keyed on the object its own factory closed over, never on the value handed to
 * the runtime.
 */
function watchForFailure(
  harness: Harness<unknown>,
  onFailure: (message?: string) => void,
): Harness<unknown> {
  return {
    ...harness,
    async *run(turn: Turn<unknown>): AsyncGenerator<HarnessEvent, void, void> {
      try {
        for await (const event of harness.run(turn)) {
          if (event.type === "error") onFailure(event.message);
          yield event;
        }
      } catch (error) {
        onFailure();
        throw error;
      }
    },
  };
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

/** The assistant's own words for the turn, read back through the real read path. */
function spokenSummary(messages: readonly UIMessage[]): string {
  const reply = [...messages].reverse().find((message) => message.role === "assistant");
  if (reply === undefined) return "";
  return conciseSummary(reply.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim());
}

/** What one run needs beyond the composition it runs on. The two faces below
 *  differ only in how they fill this. */
interface RunTurnInput {
  prompt: string;
  /** The whole tool surface for this run — guard-bound already. */
  tools: ToolRegistry;
  ctx: RunContext;
  threadId: ThreadId;
  /** The id came from the caller: reopen it (ownership-checked) rather than mint. */
  reopen: boolean;
  maxToolCalls: number;
  signal?: AbortSignal;
  output?: FlexibleSchema<unknown>;
  emit?: (event: RunEvent) => void;
}

/** ONE non-interactive harness run. Everything both faces share lives here. */
async function runTurn(deps: AwayRunnerDeps, input: RunTurnInput): Promise<AgentReport<unknown>> {
  const cap = input.maxToolCalls;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new VendoError("validation", "maxToolCalls must be a positive integer");
  }
  // Read through a call, never inline: `AbortSignal.aborted` is a readonly
  // boolean, so a narrowing here would have the compiler believe the answer
  // below cannot change — and the whole point of a signal is that it does.
  const aborted = (): boolean => input.signal?.aborted === true;
  // Cancelled before it began: no thread, no workspace, no harness. The signal
  // is the only way to stop a run, and a run stopped before its first I/O has
  // nothing to report but the stop.
  if (aborted()) {
    return {
      status: "stopped",
      summary: fallbackSummary("stopped", []),
      toolCalls: [],
      refs: { threadId: input.threadId, approvals: [] },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  // Everything the caller put on the ctx rides through untouched — the sponsor,
  // the venue, the appId, the firing trigger's id, the asserted memberships.
  // Only presence is asserted, for a caller that came in without it.
  const awayCtx: RunContext = { ...input.ctx, presence: "away" };
  const principal = awayCtx.principal;

  /** One entry per call the harness attempted, in order, each carrying the last
   *  thing known about it. `error` is the opening value only for a call whose
   *  outcome hook never fires at all. */
  const recorded: RecordedCall[] = [];
  /** Calls whose final outcome has already reached `events`. */
  const reported = new Set<string>();
  const emitResult = (entry: RecordedCall): void => {
    reported.add(entry.call.id);
    input.emit?.({ type: "tool-result", id: entry.call.id, tool: entry.call.tool, outcome: entry.outcome });
  };
  const attempted = (call: ToolCall): RecordedCall => {
    const existing = recorded.find((entry) => entry.call.id === call.id);
    if (existing !== undefined) return existing;
    const entry: RecordedCall = { call, outcome: "error" };
    recorded.push(entry);
    input.emit?.({ type: "tool-call", id: call.id, tool: call.tool, args: call.args });
    return entry;
  };
  let startedCalls = 0;
  let budgetRefused = false;
  /** Calls the budget already refused, by id: the two rails below are two halves
   *  of ONE decision, and the second must answer for exactly the call the first
   *  ruled out — never for the call that spent the last of the budget. */
  const overBudget = new Set<string>();
  let failed = false;
  let usage: UsageTotals | undefined;
  let output: unknown;
  /** The harness's own sentence for the failure, when it gave one. */
  let failureMessage: string | undefined;
  /** Every approval this run parked, in the order the guard minted them. Scoped
   *  to THIS run: the guard is shared, so a sibling run's card is not this
   *  report's to show. */
  const approvals: string[] = [];
  /** The guard's OWN per-run key (packages/guard/src/guard.ts:1104), so a card is
   *  matched the way the guard counts it: an engine firing keys on its runId,
   *  `run()` on the thread it minted. An undefined key matches NOTHING — two
   *  ctxs that both name no run are not the same run, and matching them would
   *  hand one firing's cards to another. Typed wider than `RunContext` declares
   *  on purpose: `sessionId` is required in the type and the automations engine
   *  does not set it, so the undefined case is real however the type reads. */
  const runKey: string | undefined = awayCtx.trigger?.runId ?? awayCtx.sessionId;

  await deps.store.ensureSchema();
  const transcript = threadMessageStore<UIMessage>(deps.store);
  const { threadId } = input;
  await openThread(deps.store, principal, threadId, input.reopen);
  // The SPONSOR's durable workspace, with the same `/host/skills` projection and
  // the same org mounts (§9.7) a session gets — the ctx carries the memberships
  // the caller asserted for this run.
  const workspace = await workspaceStore(deps.store, { files: deps.files ?? storeFiles(deps.store) })
    .open(principal, {
      host: hostSkillFiles(deps.skills ?? []),
      ...(awayCtx.memberships === undefined ? {} : { memberships: awayCtx.memberships }),
    });

  const schema = input.output === undefined ? undefined : asSchema(input.output);

  const runtime = createHarnessRuntime({
    // THE CALLER's registry, never one of this runner's own choosing: the caller
    // decides an unattended run's tool surface, and it is already guard-bound —
    // so §12's unattended projection is what answers `list()` here.
    tools: schema === undefined
      ? input.tools
      : withResultTool(input.tools, schema, (value) => {
        output = value;
      }),
    guard: deps.guard,
    skills: createTurnSkills(workspace),
    transcript,
    // `harnessState` is left unset on purpose — the runtime's per-run memory is
    // the whole truth for a fresh thread, so there is nothing to carry and
    // nothing to write.
    // §1.6 — the render seam, on the runtime's generic `wrapWorkspace` slot:
    // an away run's hot-path commit paints too (the part persists, so the
    // sponsor's thread shows the screen the run built). BARE — no floor, no
    // app half — because this standalone runtime composes no apps runtime to
    // fill them; the umbrella's composition does.
    wrapWorkspace: (turnWorkspace, opts) => wrapWorkspaceForRender(turnWorkspace, {
      turnId: opts.turnId,
      emit: opts.emit,
    }),
    bridge: {
      // Every call the harness ATTEMPTS, before the guard sees it — and the one
      // rail EVERY away call passes, which is why the budget is spent here. A
      // call the preview parks (`interactive: false` and nobody there to
      // approve) is denied without ever reaching `execute`, so `gate` and
      // `onCall` below never see it: charged there alone, the budget bounded
      // nothing away and a looping model minted one approval card per attempt.
      // Recording the attempt here is what keeps the run record honest too —
      // the automation asked, and it is waiting on a person.
      preflight: async (call) => {
        attempted(call);
        if (startedCalls >= cap) {
          budgetRefused = true;
          overBudget.add(call.id);
          // Returned BEFORE the guard is consulted: nothing past the bound is
          // worth a person's card, and `gate` speaks this to the model.
          return BUDGET_EXHAUSTED;
        }
        startedCalls += 1;
        // The result channel takes the same pre-guard short-circuit an
        // unconnected service does. It reaches nothing — it validates its args
        // and hands them to a closure in this function: no network, no store,
        // no host API, no file — and it pays the call budget just above. It is
        // here ONLY because an away run parks every call it cannot trace to a
        // grant, READS INCLUDED (packages/guard/src/guard.ts:1051), which would
        // strand every typed run on a card nobody can answer. DELETE THIS
        // BRANCH once the pending guard change lands and a reaches-nothing read
        // no longer parks unattended.
        return call.tool === RESULT_TOOL ? { status: "ok", output: {} } : undefined;
      },
      // The other half of the budget decision: the refusal, at the one place an
      // outcome reaches the model — nothing runs past the bound.
      gate: (call) => (overBudget.has(call.id) ? BUDGET_EXHAUSTED : undefined),
      onCall: (call) => {
        const entry = attempted(call);
        return (outcome) => {
          entry.outcome = outcome.status;
          emitResult(entry);
        };
      },
    },
    ...(deps.liveTurn === undefined ? {} : { liveTurn: deps.liveTurn }),
  });

  const system = await resolveSystem(deps, awayCtx);
  // The result channel is NAMED in the ask, not merely listed among the tools: a
  // model that never calls it returns prose where the caller asked for a shape,
  // and there is no second model call here to recover one.
  const message = asUserMessage(schema === undefined
    ? input.prompt
    : `${input.prompt}\n\nWhen you are done, call ${RESULT_TOOL} with the result.`);

  // Reopening means CONTINUING: the thread's own turns come back with it, read
  // through the same path a session's do. A fresh thread has none.
  const persisted = input.reopen ? await transcript.list(principal, threadId) : [];

  // Subscribed as LATE as possible and torn down in `finally`: the guard holds
  // its callbacks in a set forever, so a throw between the subscribe and the
  // teardown would leak one — and a foreign `threadId` is a rejection a caller
  // can repeat at will.
  const unsubscribe = deps.guard.onApprovalRequested?.((request) => {
    if (runKey !== undefined && (request.ctx.trigger?.runId ?? request.ctx.sessionId) === runKey) {
      approvals.push(request.id);
    }
    // A parked call never reaches `onCall`, so this is the only moment the run
    // learns one parked — and it is the HONEST one: a guard that threw while
    // parking mints no request, so its call keeps the opening `error` instead of
    // telling the host to wait on a card nobody has. Matched on the tool call's
    // own id (minted per call, uuid-backed), so a sibling run's card cannot mark
    // this run's call whatever the run key says.
    const parked = recorded.find((entry) => entry.call.id === request.call.id);
    if (parked !== undefined) parked.outcome = "pending-approval";
  });
  try {
    const response = await runtime.run({
      harness: watchForFailure(deps.harness, (message) => {
        failed = true;
        failureMessage = message;
      }),
      threadId,
      messages: [...persisted, message],
      ctx: awayCtx,
      workspace,
      interactive: false,
      system,
      // The harness's own vocabulary, forwarded as the runtime routes it: the
      // metering fold every caller needs, and the three things a watching caller
      // wants to see while they happen.
      observe: (event) => {
        if (event.type === "usage") usage = addUsage(usage, event);
        else if (event.type === "text") input.emit?.({ type: "text", delta: event.delta });
        else if (event.type === "status") input.emit?.({ type: "status", label: event.label });
        else if (event.type === "error") input.emit?.({ type: "error", message: event.message });
      },
      ...(deps.models === undefined ? {} : { models: deps.models }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    // Drained, not discarded: the stream's `onFinish` is what persists the turn
    // and writes its audit row, and it only fires on consumption.
    await response.text();
  } catch {
    failed = true;
  } finally {
    unsubscribe?.();
  }
  // A call the guard parked never reaches `onCall`, so its outcome has no live
  // moment to be announced in. Announced here instead, so the event stream ends
  // agreeing with the report rather than silently short of it.
  for (const entry of recorded) if (!reported.has(entry.call.id)) emitResult(entry);

  const stopped = aborted() || budgetRefused;
  const status: AgentRunReport["status"] = stopped
    ? "stopped"
    : failed ? "error" : "ok";
  // A summary is worth a lost turn, never a lost run: an unreadable transcript
  // falls back to the counted sentence rather than failing a finished run.
  const spoken = failureMessage
    ?? spokenSummary(await transcript.list(principal, threadId).catch(() => []));
  return {
    status,
    summary: spoken === "" ? fallbackSummary(status, recorded) : spoken,
    toolCalls: recorded,
    refs: { threadId, approvals },
    ...(output === undefined ? {} : { output }),
    usage: usage ?? { inputTokens: 0, outputTokens: 0 },
  };
}

/** What `run()` needs beyond {@link AwayRunnerDeps}; `agent()` fills both. */
export interface RunDeps extends AwayRunnerDeps {
  /** Attribution when the caller names no subject of their own. */
  name: string;
  /** The agent's guard-bound registry — an unattended run's whole tool surface. */
  tools: ToolRegistry;
  /** Awaited before the turn opens anything — `agent()`'s model check, so a run
   *  with no model rejects for the same reason `respond()` does, and writes no
   *  thread on the way. */
  assertModel?: () => Promise<void>;
  /** A loopback door still binding its port, exactly as `createSession` awaits
   *  it (session.ts). Without this a `claudeCode()` run can start while the
   *  door's origin is still undefined, and the box dials a URL that is not
   *  there yet. */
  doorReady?: Promise<void>;
}

/**
 * `agent.run(task)` — one unattended run, for code rather than a screen.
 *
 * Returned rather than awaited so the thread id is readable immediately (show
 * it, or hand it back as `run({ threadId })`) and `events` can be read while the
 * run is still going. Cancellation is the `signal` the caller passes; there is
 * no second way to stop a run.
 */
export function startRun<T>(deps: RunDeps, task: string, options: RunOptions<T> = {}): AgentRun<T> {
  const threadId = (options.threadId ?? `thr_${randomUUID()}`) as ThreadId;
  const queue = eventQueue<RunEvent>();
  // Both gates a turn has to clear before it opens anything, in the one place a
  // run begins: the model check, and the door still binding its port —
  // `createSession` awaits the same two.
  const settled = Promise.all([deps.assertModel?.(), deps.doorReady]).then(() => runTurn(deps, {
    prompt: task,
    tools: deps.tools,
    ctx: {
      // Unset, the agent runs as ITSELF — the subject its own audit rows are
      // attributed to, never a borrowed user.
      principal: { kind: "user", subject: options.as ?? `vendo:agent:${deps.name}` },
      venue: "automation",
      presence: "away",
      sessionId: threadId,
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.context === undefined ? {} : { context: options.context }),
    },
    threadId,
    reopen: options.threadId !== undefined,
    maxToolCalls: options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.output === undefined ? {} : { output: options.output as FlexibleSchema<unknown> }),
    emit: queue.push,
  })).finally(() => {
    queue.close();
  });
  // The doc above invites reading `threadId` and never awaiting, so a failed run
  // nobody asked about must not take the host process down (node ≥15 exits on an
  // unhandled rejection). This handler is on a DERIVED promise: `settled` itself
  // is untouched, so a caller who does await still gets the error.
  settled.catch(() => {});
  return {
    threadId,
    events: queue.iterable,
    then: (onFulfilled, onRejected) => settled.then(onFulfilled as never, onRejected),
  };
}

/**
 * The same run behind core's `AgentRunner` seam (01-core §13) — the shape the
 * automations engine and the delegation tool already speak. Prefer
 * {@link startRun} (`agent.run`) for anything new: it is this run with the
 * thread id, the live events, the usage and the typed output attached.
 *
 * `AgentComposition` (what `agentComposition(agent)` returns) satisfies these deps
 * structurally, so a host that already built an `agent()` can hand its composition
 * straight in.
 */
export function awayRunner(deps: AwayRunnerDeps): AgentRunner {
  return (task, ctx) => runTurn(deps, {
    prompt: task.prompt,
    tools: task.tools,
    ctx,
    threadId: `thr_${randomUUID()}` as ThreadId,
    reopen: false,
    maxToolCalls: task.budget?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    ...(task.abortSignal === undefined ? {} : { signal: task.abortSignal }),
  });
}

