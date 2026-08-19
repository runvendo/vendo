/**
 * ONE turn, in both venues — the object a caller holds while it runs, and the
 * assembly that runs it.
 *
 * `chat()` and `run()` are the same turn wearing two contexts: a present user's
 * conversation and an unattended run differ in venue, in presence, and in
 * whether the answer has a declared shape — and in nothing else. So there is one
 * {@link runTurn} here rather than one per lane. `session()`/`respond()` are NOT
 * this lane: they hand back a streaming `Response` and BLOCK on an approval, and
 * they are untouched.
 *
 * DRAINER OF RECORD. The turn executes and persists whether or not anyone reads
 * `events` and whether or not anyone awaits it: `await response.text()` below is
 * what fires the stream's `onFinish`, and `onFinish` is what writes the
 * transcript and the audit row. `events` is an INDEPENDENT tap on the same run —
 * a turn nobody taps still happens, in full.
 *
 * A PARK ENDS THE TURN. Every turn here runs `interactive: false`, so a call the
 * guard wants a person for refuses on the spot instead of blocking on the 90s
 * approval waiter: `await turn` answers `interrupted` in the time the turn took,
 * never in a minute and a half. Presence is the CTX's and is untouched by that
 * flag (`ToolListingContext`), so a chat turn still runs `presence: "present"`
 * and still sees the whole present-user tool surface.
 */
import {
  VendoError,
  createTurnSkills,
  hostSkillFiles,
  mintTurnId,
  type ApprovalRequest,
  type Decisions,
  type FilesAdapter,
  type Guard,
  type Harness,
  type HarnessEvent,
  type Json,
  type JsonSchema,
  type ResumeOptions,
  type RunContext,
  type SeatModels,
  type Skill,
  type ThreadId,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
  type Turn as HarnessTurn,
  type TurnId,
  type TurnResult as CoreTurnResult,
} from "@vendoai/core";
import { wrapWorkspaceForRender } from "@vendoai/apps";
import type { VendoGuard } from "@vendoai/guard";
import { addUsage, createHarnessRuntime, type HarnessRuntimeDeps, type UsageTotals } from "@vendoai/harnesses";
import {
  harnessStateStore,
  storeFiles,
  threadMessageStore,
  workspaceStore,
  type VendoStore,
} from "@vendoai/store";
import { asSchema, type FlexibleSchema, type LanguageModel, type Schema, type UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import type { MemoryAdapter } from "./memory.js";
import { resolveSystem, type SystemPromptHook } from "./prompt.js";
import { asUserMessage, openThread, toHeaderRecord } from "./session.js";

/** The union, with the AGENTS-level `Turn` bound into the arm that resumes.
 *  Core owns the definition; this only names the loop core cannot. */
export type TurnResult<T = void> = CoreTurnResult<T, Turn<T>>;

/**
 * A turn in flight.
 *
 * Returned rather than awaited so `threadId` and `turnId` are readable
 * immediately — show them, hand the thread back on the next call, or join the
 * turn's audit rows — and so `events` can be read while the turn is still going.
 */
export interface Turn<T = void> extends PromiseLike<TurnResult<T>> {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  /** Read ONCE, while the turn runs: nothing is kept for a reader that never
   *  attaches, and a second reader alongside the first throws. */
  readonly events: AsyncIterable<RunEvent>;
}

/** What a caller can watch a turn do while it runs. The harness's own vocabulary
 *  for what it SAYS (`text`/`status`/`error`, straight off the runtime's
 *  `observe` tap) plus the two things it DOES, off the same bridge rails the
 *  result is assembled from. */
export type RunEvent =
  | { type: "text"; delta: string }
  | { type: "status"; label: string }
  | { type: "error"; message: string }
  | { type: "tool-call"; id: string; tool: string; args: Json }
  | { type: "tool-result"; id: string; tool: string; outcome: ToolOutcome["status"] };

export interface ChatOptions {
  /** Whose turn this is — the subject every grant, workspace and audit row is
   *  scoped to. Unset, the agent talks as itself. */
  as?: string;
  /** Server-trust identity facts, model-visible (`[User]`). */
  user?: Record<string, Json>;
  /** Guard/tools context: functions run at check-time, data survives parking. */
  context?: Record<string, unknown>;
  /** Present-user auth forwarding — the request's own headers. Per call, never
   *  bound: request-lifetime authority does not outlive the request. */
  headers?: Record<string, string> | Headers;
  /** Continue a conversation this subject already owns instead of starting one.
   *  Omit it for a new thread; see {@link openingThread} for why passing an
   *  explicit `undefined` is refused. */
  threadId?: string;
  signal?: AbortSignal;
}

/** The composition ONE turn runs on. */
export interface TurnDeps {
  /** The brain, with its knobs already bound. */
  harness: Harness<unknown>;
  store: VendoStore;
  guard: Guard;
  /** Where workspace blobs land; unset → the store's own rows. */
  files?: FilesAdapter;
  /** Projected into the read-only `/host/skills` mount, as in a session. */
  skills?: readonly Skill[];
  /** Per-user memory. Declared here because `resolveSystem` below reads it off
   *  this object to fill `[Memory]`: undeclared, the block worked only as long
   *  as the caller happened to pass a wider object. */
  memory?: MemoryAdapter;
  /** The host's prompt block. */
  instructions?: string;
  /**
   * The turn's system prompt, for a composition that already has one. Handed this
   * package's own assembly (`instructions`, the ctx's situation data, and the
   * guard's directions); a returned string is used verbatim, `undefined` is that
   * default — never a promptless turn.
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

/** What `agent()` composed, as {@link startTurn} needs it: the agent's own name
 *  and tool surface, the two gates a turn clears before it opens anything, and
 *  the guard in its full form — deciding an approval on resume is a
 *  `VendoGuard` verb. */
export interface AgentDeps extends TurnDeps {
  /** Attribution when the caller names no subject of their own. */
  name: string;
  /**
   * WHICH agent this is — `agent({ name })`, carried by the composition rather
   * than read off {@link AgentDeps.name}, which is a label whoever assembles
   * these deps fills in.
   *
   * It rides every turn's ctx onto the rows that turn parks, and it is the axis
   * `turns.list`/`turns.resume` filter on (interruptions.ts). Two agents over
   * one store share one approvals collection — `serve({ agents: [a, b] })` is
   * exactly that — and a park named only the subject, the thread and the turn,
   * so a person's yes to `ops` dispatched `support`'s same-named tool and
   * `support.turns.list()` returned `ops`' turn verbatim.
   *
   * Optional because a composition assembled by hand names no agent; absent,
   * its parked turns belong to nobody and neither face offers them.
   */
  agent?: string;
  /** The agent's guard-bound registry — the turn's whole tool surface. */
  tools: ToolRegistry;
  guard: VendoGuard;
  /** Awaited before the turn opens anything — `agent()`'s model check, so a turn
   *  with no model fails for the same reason `respond()` does, and writes no
   *  thread on the way. */
  assertModel?: () => Promise<void>;
  /** A loopback door still binding its port, exactly as `createSession` awaits
   *  it (session.ts). Without this a `claudeCode()` turn can start while the
   *  door's origin is still undefined, and the box dials a URL that is not
   *  there yet. */
  doorReady?: Promise<void>;
}

/**
 * The thread this call MEANT.
 *
 * Omitted is a new conversation. Present and explicitly `undefined` is a
 * mistake, and it is refused rather than quietly forked: `{ threadId:
 * thread?.id }` on a value that was not there is the one way a caller loses a
 * conversation without ever being told. Detected with `in`, because `undefined`
 * and absent are the two cases that have to be told apart.
 *
 * It THROWS where a foreign id rejects, and the difference is the point: a
 * malformed call is wrong before anything opens, an unowned thread is a lookup
 * that failed.
 */
export function openingThread(options: { threadId?: string }): { threadId: ThreadId; reopen: boolean } {
  if ("threadId" in options && options.threadId === undefined) {
    throw new VendoError(
      "validation",
      "threadId was passed as undefined. Omit it to start a new conversation, or pass the id the "
      + "last turn returned — an undefined id would silently start a second conversation and lose the first.",
    );
  }
  return options.threadId === undefined
    ? { threadId: `thr_${randomUUID()}` as ThreadId, reopen: false }
    : { threadId: options.threadId as ThreadId, reopen: true };
}

/** One entry per call the harness attempted, in order, each carrying the last
 *  thing known about it. */
export interface RecordedCall {
  call: ToolCall;
  outcome: ToolOutcome["status"];
}

/** What ONE turn left behind, before either face shapes it: {@link startTurn}
 *  reads it into a {@link TurnResult}, `awayRunner` into core's
 *  `AgentRunReport`. */
export interface TurnRecord {
  /** The assistant's OWN words for this turn, in full — never a narrowing. */
  text: string;
  toolCalls: RecordedCall[];
  usage: UsageTotals;
  /** Every approval this turn parked, in the order the guard minted them. */
  parked: ApprovalRequest[];
  /** Something outside the turn called time on it. */
  stopped?: "aborted" | "maxToolCalls";
  /** The turn broke; the harness's own sentence for it when it gave one. */
  failed?: { message?: string };
  /** Present only when `output` was asked for AND the model filled it in. */
  output?: unknown;
}

/** What one turn needs beyond the composition it runs on. */
export interface TurnInput {
  prompt: string;
  /** The whole tool surface for this turn — guard-bound already. */
  tools: ToolRegistry;
  ctx: RunContext;
  threadId: ThreadId;
  turnId: TurnId;
  /** The id came from the caller: reopen it (ownership-checked) rather than mint. */
  reopen: boolean;
  maxToolCalls: number;
  signal?: AbortSignal;
  output?: FlexibleSchema<unknown>;
  emit?: (event: RunEvent) => void;
  /** Interruptions a caller answered, settled before the model thinks again. The
   *  guard rides along because deciding an approval is a `VendoGuard` verb while
   *  a turn's composition is typed on core's narrower `Guard`. */
  resume?: { guard: VendoGuard; parked: readonly ApprovalRequest[]; decisions: Decisions };
}

/** The turn's return channel for a declared answer. Named, rather than parsed
 *  back out of prose, because the args the model already assembled ARE the
 *  answer. */
const RESULT_TOOL = "vendo_result";

/** What a caller with no budget gets. The automations engine always passes its
 *  own (50), so this only bounds a host driving a turn directly. */
export const DEFAULT_MAX_TOOL_CALLS = 20;

/** What a call past the turn's budget gets. Two rails answer with it: `preflight`
 *  rules the call out before the guard can park it, and `gate` — the rail whose
 *  outcome reaches the model — repeats it for that same call. */
const BUDGET_EXHAUSTED: ToolOutcome = {
  status: "error",
  error: { code: "budget-exhausted", message: "Tool-call budget exhausted" },
};

/** What a turn LEFT UNSAID when it broke. `text` is empty on the error arm by
 *  contract, so the sentence has to live in the error. */
const TURN_FAILED = "The turn could not be completed.";

/**
 * The typed-output surface: one synthetic tool on THIS turn's registry, whose
 * args are validated against the caller's schema.
 *
 * Deliberately OUTSIDE the guard binding. It reaches nothing — no network, no
 * host API, no file — so there is nothing for a person to approve, and an
 * unattended turn whose result channel parked on an approval card would be a
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
        // and call again rather than the turn failing on a fixable mistake.
        return { status: "error", error: { code: "validation", message: checked.error.message } };
      }
      capture(checked.value);
      return { status: "ok", output: { recorded: true } };
    },
  };
}

/** One buffer, one waiter — everything an `AsyncIterable` fed from callbacks
 *  needs. Nothing is buffered unless a reader is attached: a turn whose events
 *  nobody reads is the common case, and buffering for it grew without a bound. */
function eventQueue<T>(): { push: (item: T) => void; close: () => void; iterable: AsyncIterable<T> } {
  const buffered: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let reading = false;
  const nudge = (): void => {
    wake?.();
    wake = undefined;
  };
  return {
    push: (item) => {
      if (!reading) return;
      buffered.push(item);
      nudge();
    },
    close: () => {
      closed = true;
      nudge();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        if (reading) throw new VendoError("validation", "run.events is single-reader — it is already being read.");
        reading = true;
        try {
          while (true) {
            while (buffered.length > 0) yield buffered.shift() as T;
            if (closed) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        } finally {
          // A reader that LEFT is no reader at all — `break` gets here through
          // `.return()`. What it did not take is dropped and nothing more is
          // kept, or a cancelled read leaves the buffer growing forever, which
          // is the whole growth this queue exists to avoid. Its seat goes back
          // only while the turn is still going: single-reader is there so two
          // consumers cannot split ONE live stream, and a finished turn has
          // nothing left to hand a replacement, so reading it again stays the
          // named error rather than a silently empty stream.
          buffered.length = 0;
          if (!closed) reading = false;
        }
      },
    },
  };
}

/**
 * Watch the harness's own closed vocabulary for a failure, without taking
 * anything away from the runtime.
 *
 * A harness `error` event reaches the SCREEN's error channel and never the
 * transcript (runtime.ts), so it is invisible to a caller that only reads the
 * persisted turn — and "the nightly digest failed" reported as a successful turn
 * is the failure this whole seam exists to avoid. A throw is left to propagate:
 * the runtime's own handler already puts its plain sentence in the transcript,
 * so only the STATUS is missing here.
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
    async *run(turn: HarnessTurn<unknown>): AsyncGenerator<HarnessEvent, void, void> {
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

/** The assistant's own words for the turn, read back through the real read path. */
function spokenText(messages: readonly UIMessage[]): string {
  const reply = [...messages].reverse().find((message) => message.role === "assistant");
  if (reply === undefined) return "";
  return reply.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/** Past its TTL, the ask is dead whether or not a sweep has been by. Nothing in
 *  this package sweeps (the umbrella's `compose-sweep.ts` is the only caller of
 *  `sweepExpiredApprovals`), so expiry is decided where it is read: a turn a
 *  host composed without a sweeper still keeps the seven-day promise, and it
 *  keeps it with a sentence instead of a silence. */
export const expired = (request: ApprovalRequest, ttlMs: number, at: number): boolean =>
  ttlMs > 0 && Date.parse(request.createdAt) + ttlMs <= at;

/**
 * What a resume is refused for — on BOTH faces.
 *
 * `turns.resume` reads the store and can say no before a turn opens; the
 * `resume()` a caller is still holding used to say nothing at all, so the same
 * guard and the same deadline gave opposite answers to the same ask. Checked
 * HERE, at the one door every resume goes through, so neither face can grow a
 * rule of its own — and BEFORE {@link settleInterruptions}, because both of
 * these refusals must leave a one-shot ask still answerable.
 */
function assertAnswerable(deps: AgentDeps, turnId: TurnId, resume: TurnInput["resume"]): void {
  if (resume === undefined) return;
  for (const request of resume.parked) {
    const decision = resume.decisions[request.id];
    // A verdict, or nothing at all. `{ answers }` type-checks against an
    // approval arm and is not a verdict, and `settleInterruptions` calls
    // everything that is not "approve" a no — so a shape nobody meant (and a
    // "Approve" nobody misread) landed as a DENIAL nobody made, on an ask that
    // is answered exactly once.
    if (decision !== undefined && decision !== "approve" && decision !== "deny") {
      throw new VendoError(
        "validation",
        `Approval ${request.id} was answered with ${JSON.stringify(decision)}, which is not a verdict. `
        + "An approval takes \"approve\" or \"deny\" — nothing was decided, so it is still there to answer.",
      );
    }
  }
  const ttlMs = deps.guard.approvals.parkedCallTtlMs;
  const stale = resume.parked.find((request) => expired(request, ttlMs, Date.now()));
  if (stale !== undefined) {
    throw new VendoError(
      "conflict",
      `Turn ${turnId} parked on ${stale.createdAt} and what it was waiting on expired on `
      + `${new Date(Date.parse(stale.createdAt) + ttlMs).toISOString()}. Nothing it asked for ran, and an `
      + "expired ask cannot be answered — send the request again and the agent will ask again.",
    );
  }
}

/**
 * Answer the interruptions the caller decided, and say what came of them.
 *
 * An approved call is RE-DISPATCHED byte for byte — the exact `ToolCall` the
 * guard parked, through the same guard-bound registry — because a fresh call id
 * misses the guard's approved replay (`sameParkedCall`, guard.ts) and would only
 * park a second time. Asking the model to call it again is therefore not a
 * resume; re-dispatching it is, and the guard's one-shot receipt is what keeps
 * it from running twice.
 *
 * What comes back is the resumed turn's ask. The model was told its call needed
 * approval, so the honest next thing it reads is what the person said and what
 * happened. It rides a user message because the transcript has no other channel
 * a fact enters a turn through, and it is durable on purpose: a reload has to
 * show the approved call, not a gap where one was.
 */
async function settleInterruptions(
  resume: NonNullable<TurnInput["resume"]>,
  tools: ToolRegistry,
  ctx: RunContext,
  ran: (call: ToolCall, outcome: ToolOutcome) => void,
): Promise<string> {
  const lines: string[] = [];
  for (const request of resume.parked) {
    const decision = resume.decisions[request.id];
    if (decision === undefined) continue;
    const approve = decision === "approve";
    await resume.guard.approvals.decide([request.id], { approve }, ctx.principal);
    if (!approve) {
      lines.push(`- ${request.call.tool}: turned down. It did not run.`);
      continue;
    }
    const outcome = await tools.execute(request.call, ctx);
    ran(request.call, outcome);
    lines.push(`- ${request.call.tool}: approved, and it has now run — ${JSON.stringify(outcome)}`);
  }
  return `[Resumed] The approvals this conversation was waiting on have been answered.\n${lines.join("\n")}`
    + "\n\nPick up from there and tell me how it went.";
}

/** ONE harness turn — everything both venues share. */
export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnRecord> {
  const cap = input.maxToolCalls;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new VendoError("validation", "maxToolCalls must be a positive integer");
  }
  // Read through a call, never inline: `AbortSignal.aborted` is a readonly
  // boolean, so a narrowing here would have the compiler believe the answer
  // below cannot change — and the whole point of a signal is that it does.
  const aborted = (): boolean => input.signal?.aborted === true;
  // Cancelled before it began: no thread, no workspace, no harness. The signal
  // is the only way to stop a turn, and a turn stopped before its first I/O has
  // nothing to report but the stop.
  if (aborted()) {
    return { text: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, parked: [], stopped: "aborted" };
  }
  // Everything the caller put on the ctx rides through untouched — the sponsor,
  // the venue, the presence, the appId, the firing trigger's id, the asserted
  // memberships. The turn's own id joins it, so every audit row, mirrored call
  // and painted view this turn produces names the turn a caller is holding.
  const ctx: RunContext = { ...input.ctx, turnId: input.turnId };
  const principal = ctx.principal;

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
  const parked: ApprovalRequest[] = [];
  /** The guard's OWN per-run key (packages/guard/src/guard.ts:1104), so a card is
   *  matched the way the guard counts it: an engine firing keys on its runId,
   *  everything else on the thread it is on. An undefined key matches NOTHING —
   *  two ctxs that both name no run are not the same run, and matching them would
   *  hand one firing's cards to another. Typed wider than `RunContext` declares
   *  on purpose: `sessionId` is required in the type and the automations engine
   *  does not set it, so the undefined case is real however the type reads. */
  const runKey: string | undefined = ctx.trigger?.runId ?? ctx.sessionId;

  await deps.store.ensureSchema();
  const transcript = threadMessageStore<UIMessage>(deps.store);
  const { threadId } = input;
  await openThread(deps.store, principal, threadId, input.reopen);
  // The SPONSOR's durable workspace, with the same `/host/skills` projection and
  // the same org mounts (§9.7) a session gets — the ctx carries the memberships
  // the caller asserted for this turn.
  const workspace = await workspaceStore(deps.store, { files: deps.files ?? storeFiles(deps.store) })
    .open(principal, {
      host: hostSkillFiles(deps.skills ?? []),
      ...(ctx.memberships === undefined ? {} : { memberships: ctx.memberships }),
    });

  const schema = input.output === undefined ? undefined : asSchema(input.output);

  const runtime = createHarnessRuntime({
    // THE CALLER's registry, never one of this turn's own choosing: the caller
    // decides the tool surface, and it is already guard-bound — so §12's
    // projection is what answers `list()` here.
    tools: schema === undefined
      ? input.tools
      : withResultTool(input.tools, schema, (value) => {
        output = value;
      }),
    guard: deps.guard,
    skills: createTurnSkills(workspace),
    transcript,
    // The same door a session keeps: a turn that CONTINUES a thread has to carry
    // what the harness remembered on it, and a fresh thread has nothing stored,
    // so wiring it costs the fresh case nothing.
    harnessState: harnessStateStore(deps.store),
    // §1.6 — the render seam, on the runtime's generic `wrapWorkspace` slot: a
    // commit that lands `app.tsx` paints (the part persists, so the thread shows
    // the screen the turn built). BARE — no floor, no app half — because this
    // standalone runtime composes no apps runtime to fill them; the umbrella's
    // composition does.
    wrapWorkspace: (turnWorkspace, opts) => wrapWorkspaceForRender(turnWorkspace, {
      turnId: opts.turnId,
      emit: opts.emit,
    }),
    bridge: {
      // Every call the harness ATTEMPTS, before the guard sees it — and the one
      // rail EVERY call passes, which is why the budget is spent here. A call the
      // preview parks is refused without ever reaching `execute`, so `gate` and
      // `onCall` below never see it: charged there alone, the budget bounded
      // nothing away and a looping model minted one approval card per attempt.
      // Recording the attempt here is what keeps the record honest too — the turn
      // asked, and it is waiting on a person.
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
        // here ONLY because an away turn parks every call it cannot trace to a
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

  const system = await resolveSystem(deps, ctx);

  // Subscribed as LATE as possible and torn down in `finally`: the guard holds
  // its callbacks in a set forever, so a throw between the subscribe and the
  // teardown would leak one — and a foreign `threadId` is a rejection a caller
  // can repeat at will.
  const unsubscribe = deps.guard.onApprovalRequested?.((request) => {
    // The run key alone is the THREAD for a chat turn, and nothing serialises a
    // thread: two turns running at once each collected the other's cards, so a
    // resume of one decided and re-dispatched the other's call. The turn that
    // asked is on the row (guard.ts, `#parkApproval`) — matched on it, a turn's
    // interruptions are its own.
    if (
      runKey !== undefined
      && (request.ctx.trigger?.runId ?? request.ctx.sessionId) === runKey
      && request.ctx.turnId === input.turnId
    ) {
      parked.push(request);
    }
    // A parked call never reaches `onCall`, so this is the only moment the turn
    // learns one parked — and it is the HONEST one: a guard that threw while
    // parking mints no request, so its call keeps the opening `error` instead of
    // telling the host to wait on a card nobody has. Matched on the tool call's
    // own id (minted per call, uuid-backed), so a sibling turn's card cannot mark
    // this turn's call whatever the run key says.
    const waiting = recorded.find((entry) => entry.call.id === request.call.id);
    if (waiting !== undefined) waiting.outcome = "pending-approval";
  });
  try {
    // The answered interruptions land BEFORE the model thinks again, so what it
    // reads is already true.
    const ask = input.resume === undefined
      ? input.prompt
      : await settleInterruptions(input.resume, input.tools, ctx, (call, outcome) => {
        attempted(call).outcome = outcome.status;
      });
    // The result channel is NAMED in the ask, not merely listed among the tools:
    // a model that never calls it returns prose where the caller asked for a
    // shape, and there is no second model call here to recover one.
    const message = asUserMessage(schema === undefined
      ? ask
      : `${ask}\n\nWhen you are done, call ${RESULT_TOOL} with the result.`);
    // Reopening means CONTINUING: the thread's own turns come back with it, read
    // through the same path a session's do. A fresh thread has none.
    const persisted = input.reopen ? await transcript.list(principal, threadId) : [];

    const response = await runtime.run({
      harness: watchForFailure(deps.harness, (failure) => {
        failed = true;
        failureMessage = failure;
      }),
      threadId,
      messages: [...persisted, message],
      ctx,
      workspace,
      // A park ENDS this turn: nobody is blocked on the 90s waiter, and the card
      // stands for `resume()`. See this file's header.
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
    // and writes its audit row, and it only fires on consumption. THIS is the
    // drainer-of-record property — nothing a client does or fails to do changes
    // whether the turn happened.
    await response.text();
  } catch {
    failed = true;
  } finally {
    unsubscribe?.();
  }
  // A call the guard parked never reaches `onCall`, so its outcome has no live
  // moment to be announced in. Announced here instead, so the event stream ends
  // agreeing with the result rather than silently short of it.
  for (const entry of recorded) if (!reported.has(entry.call.id)) emitResult(entry);

  // A turn's words are worth a lost read, never a lost turn: an unreadable
  // transcript answers with nothing rather than failing a finished turn.
  return {
    text: spokenText(await transcript.list(principal, threadId).catch(() => [])),
    toolCalls: recorded,
    usage: usage ?? { inputTokens: 0, outputTokens: 0 },
    parked,
    ...(aborted() ? { stopped: "aborted" as const } : budgetRefused ? { stopped: "maxToolCalls" as const } : {}),
    ...(failed ? { failed: failureMessage === undefined ? {} : { message: failureMessage } } : {}),
    ...(output === undefined ? {} : { output }),
  };
}

/**
 * One turn's four ends, out of what it left behind.
 *
 * Order is the answer to "what actually ended this": something outside it called
 * time, or it broke, or it is waiting on a person, or it finished. A turn asked
 * for a shaped answer that never reported one is an ERROR, never a silent `ok`
 * with nothing in it.
 */
function shape<T>(deps: AgentDeps, input: Omit<TurnInput, "tools" | "emit">, record: TurnRecord): TurnResult<T> {
  const ran = {
    text: record.text,
    threadId: input.threadId,
    turnId: input.turnId,
    toolCalls: record.toolCalls,
    usage: record.usage,
  };
  // `unavailable` is the honest code for every one of these: the turn broke on
  // the SERVER's side of the seam, so running it again verbatim is the right
  // next move. A refusal a caller could fix would have thrown before the turn
  // ever opened (see {@link openingThread}).
  const broke = (message: string): TurnResult<T> => ({
    status: "error",
    text: "",
    threadId: input.threadId,
    turnId: input.turnId,
    error: { code: "unavailable", message },
  });
  if (record.stopped !== undefined) return { ...ran, status: "stopped", reason: record.stopped };
  if (record.failed !== undefined) {
    return broke(record.failed.message ?? (record.text === "" ? TURN_FAILED : record.text));
  }
  if (record.parked.length > 0) {
    return {
      ...ran,
      status: "interrupted",
      interruptions: record.parked.map((request) => ({
        id: request.id,
        type: "approval",
        toolCall: request.call,
      })),
      // The SAME turn, carrying on: one turn id across park and resume, so the
      // thing a caller answered is the thing they get an answer about.
      resume: (decisions, options) => startTurn<T>(deps, {
        ...input,
        reopen: true,
        ctx: resumedContext(input.ctx, options),
        resume: { guard: deps.guard, parked: record.parked, decisions },
      }),
    };
  }
  if (input.output !== undefined && record.output === undefined) {
    return broke("The run finished without reporting the result it was asked for.");
  }
  return { ...ran, status: "ok", output: record.output as T };
}

/** The ctx a resumed turn runs on. Authority comes from the RESUMING call and
 *  never from the dead one: the parked turn's request headers were
 *  request-lifetime and that request is over, so they are DROPPED unless this
 *  call brings its own. Its context wins over what the parked turn carried. */
const resumedContext = (ctx: RunContext, options: ResumeOptions | undefined): RunContext => {
  const { requestHeaders, ...carried } = ctx;
  const headers = toHeaderRecord(options?.headers);
  return {
    ...carried,
    ...(headers === undefined ? {} : { requestHeaders: headers }),
    ...(options?.context === undefined ? {} : { context: { ...ctx.context, ...options.context } }),
  };
};

/**
 * Start one turn and hand back the object it runs behind.
 *
 * The gates a turn clears before it opens anything are here, in the one place a
 * turn begins: the model check, and a door still binding its port —
 * `createSession` awaits the same two.
 */
export function startTurn<T = void>(deps: AgentDeps, input: Omit<TurnInput, "tools" | "emit">): Turn<T> {
  const queue = eventQueue<RunEvent>();
  const settled = Promise.all([deps.assertModel?.(), deps.doorReady])
    .then(() => {
      assertAnswerable(deps, input.turnId, input.resume);
      return runTurn(deps, {
        ...input,
        // WHOSE turn this is, onto every row it parks — the axis `turns` filters
        // a parked turn by (see {@link AgentDeps.agent}).
        ctx: deps.agent === undefined ? input.ctx : { ...input.ctx, agent: deps.agent },
        tools: deps.tools,
        emit: queue.push,
      });
    })
    .finally(() => {
      queue.close();
    })
    .then((record) => shape<T>(deps, input, record));
  // The doc above invites reading `threadId` and never awaiting, so a turn that
  // failed before it began and nobody asked about must not take the host process
  // down (node ≥15 exits on an unhandled rejection). This handler is on a DERIVED
  // promise: `settled` itself is untouched, so a caller who does await still gets
  // the error.
  settled.catch(() => {});
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    events: queue.iterable,
    then: (onFulfilled, onRejected) => settled.then(onFulfilled as never, onRejected),
  };
}

/**
 * `agent.chat(message)` — one turn of a conversation, for code that wants the
 * answer rather than a stream.
 *
 * No output schema by design: a chat turn's answer is what the assistant SAID.
 * `run()` is the lane with a declared shape.
 */
export function startChat(deps: AgentDeps, message: string, options: ChatOptions = {}): Turn {
  const opening = openingThread(options);
  const headers = toHeaderRecord(options.headers);
  return startTurn(deps, {
    ...opening,
    prompt: message,
    ctx: {
      // Unset, the agent talks as ITSELF — the subject its own audit rows are
      // attributed to, never a borrowed user. The same default `run()` takes.
      principal: { kind: "user", subject: options.as ?? `vendo:agent:${deps.name}` },
      venue: "chat",
      presence: "present",
      // The thread this turn is on: the guard scopes a parked card by it, and
      // `resume()` finds the card again through the same key.
      sessionId: opening.threadId,
      ...(headers === undefined ? {} : { requestHeaders: headers }),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.context === undefined ? {} : { context: options.context }),
    },
    turnId: mintTurnId(),
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
