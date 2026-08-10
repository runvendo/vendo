/**
 * The harness runtime — build contract §1.6.
 *
 * It builds the `Turn`, runs any `Harness`, converts the closed `HarnessEvent`
 * vocabulary plus mirrored tool calls into the EXISTING ai-SDK UIMessage stream,
 * persists the transcript one row per message, and enforces the frozen routing
 * table. Hot-path views ride the injected `wrapWorkspace` slot — the runtime
 * carries no app knowledge of its own.
 *
 * It decides nothing. Orchestration is thinking, and thinking is the harness's.
 */
import {
  auditContext,
  mintTurnId,
  VendoError,
  withSseKeepalive,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type Harness,
  type HarnessEvent,
  type Principal,
  type RunContext,
  type SeatModels,
  type ThreadId,
  type ToolRegistry,
  type Turn,
  type TurnId,
  type TurnSkills,
  type TurnTools,
  type WorkspaceFs,
} from "@vendoai/core";
import {
  abandonPendingApprovals,
  clearFailedTurnRecord,
  guardApprovalIds,
  validateUpsert,
} from "./transcript-rules.js";
import { createCapabilityMissDetector, type CapabilityMissConfig } from "./capability-miss.js";
import type { ToolBridgeOptions } from "./tool-bridge.js";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  readUIMessageStream,
  type LanguageModel,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import {
  classifyHistory,
  createTurnState,
  memoryHarnessStateStore,
  type HarnessStateStore,
} from "./harness-state.js";
import { createTurnTools, type MirrorEvent } from "./turn-tools.js";
import { specificWireErrorMessage } from "./wire-error.js";
import { emitWorkbench, openWorkbench } from "./workbench.js";
import { TextChannel, writeDebug, writeError, writeMirror, writeStatus, writeTurnError, writeView } from "./wire.js";

/**
 * `turn.messages` is OURS and read-only (§1). A frozen array still hands out live
 * part objects, so a harness could rewrite canonical history by mutating
 * `parts[0].text` — and the runtime would then persist the harness's edit as the
 * user's own words. Deep-freezing the view closes that; the pristine copy the
 * runtime diffs against closes it even if a host passes an unfrozen structure.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Build contract §6 — lane D's `threadMessageStore(store)` return value. Typed
 *  structurally so this package never imports @vendoai/store: the store handle
 *  arrives as a composed value. */
export interface TranscriptStore {
  /** One row per message; per-row CAS on `revision` for edits. */
  upsert(principal: Principal, threadId: ThreadId, message: UIMessage, seq: number): Promise<void>;
  /** Reassembled by seq, oldest → newest. */
  list(principal: Principal, threadId: ThreadId): Promise<UIMessage[]>;
}

export interface HarnessRuntimeDeps {
  /** The GUARD-BOUND registry (`VendoGuard.bind(hostTools)`) — the one choke
   *  point every harness's calls pass through, whatever the dialect. */
  tools: ToolRegistry;
  guard: Guard;
  skills: TurnSkills;
  transcript: TranscriptStore;
  /** Defaults to process-lifetime memory: a session id is disposable by contract. */
  harnessState?: HarnessStateStore;
  /**
   * Wrap the turn's workspace before the harness sees it — the one injection
   * point for a commit-intercepting façade (the render seam is composition's
   * implementation; see `wrapWorkspaceForRender` in `@vendoai/apps`). `emit`
   * writes a data part on the wire's view channel for this turn; `turnId` is
   * the turn being wrapped. Unset, the harness runs on the workspace as given —
   * the runtime itself knows nothing about apps.
   */
  wrapWorkspace?: (
    workspace: WorkspaceFs,
    opts: { emit: (streamId: string, part: unknown) => void; turnId: TurnId },
  ) => WorkspaceFs;
  /** The shipped tool-bridge rails composition owns: `toolOutputCap`, the
   *  `preflight` connect gate, and the capability-miss `onCall` hook. The writer
   *  and the per-turn connect-card set are the runtime's to supply. */
  bridge?: Omit<ToolBridgeOptions, "registry" | "ctx" | "guard" | "writer" | "connectCards">;
  /** Test seam only; production uses the frozen APPROVAL_WAIT_MS. */
  approvalWaitMs?: number;
  /**
   * Publish the turn now in flight to the host process's own doors, and retract
   * it at turn end (the returned disposer).
   *
   * The one consumer today is the MCP door's turn credential (10-mcp §3b): a
   * `claudeCode()` box reaches its host's tools over native remote MCP, and the
   * door has to answer with THIS turn's ctx, THIS turn's equipped tools and THIS
   * turn's approval card — the same `turn.tools` the harness holds, not a
   * reconstruction of it. Publishing is not a grant: nothing can be reached
   * without a credential the harness minted, and the credential's whole
   * authority is the window between this call and its disposer.
   */
  liveTurn?: (published: {
    threadId: ThreadId;
    ctx: RunContext;
    tools: TurnTools;
    /**
     * Hand the user's words to THIS turn while it runs (§10.2), and answer
     * whether they landed. Published here rather than through a second hook
     * because "the turn now in flight, reachable by the process's own doors" is
     * exactly what this hook already means.
     */
    steer: (text: string, messageId: string) => Promise<boolean>;
  }) => () => void;
}

export interface TurnRunInput<Options = unknown> {
  harness: Harness<Options>;
  threadId: ThreadId;
  /** The canonical transcript for this turn, INCLUDING the new user message. */
  messages: UIMessage[];
  ctx: RunContext;
  workspace: WorkspaceFs;
  /** The seats `Turn.models` carries (contract §4, relaxed): any subset — only
   *  a seat the harness actually reads matters. Unset = no seats, which is the
   *  whole truth for a harness like `claudeCode()` that brings its own brain. */
  models?: SeatModels<LanguageModel>;
  options?: Options;
  /** §1.4 — did the caller prove presence (a click/message/submit)? */
  interactive: boolean;
  /** The assembled system prompt for THIS turn (`Turn.system`). Composition's to
   *  assemble — it is venue-gated and carries the guard's directions, so it needs
   *  the ctx — and the runtime's to deliver, which is what puts a NAMED harness on
   *  the same brief as the default one. */
  system?: string;
  /** The capability-miss rail for THIS turn: the honest-refusal reporter, listed
   *  beside the projected tools, plus the repeated-failure detector on the
   *  bridge. Per turn, not per runtime, because the intent is the user's latest
   *  ask (`latestUserIntent(messages)`). */
  capabilityMiss?: { config: CapabilityMissConfig; intent: string; threadId?: ThreadId };
  signal?: AbortSignal;
}

export interface HarnessRuntime {
  run<Options>(input: TurnRunInput<Options>): Promise<Response>;
}

const mintAuditId = (): string => `aud_${globalThis.crypto.randomUUID()}`;

/** The metering figures an audit row carries — the `usage` HarnessEvent's own
 *  shape, which is why a harness can hand one straight over. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

function addUsage(totals: UsageTotals | undefined, event: Extract<HarnessEvent, { type: "usage" }>): UsageTotals {
  const base = totals ?? { inputTokens: 0, outputTokens: 0 };
  const next: UsageTotals = {
    inputTokens: base.inputTokens + event.inputTokens,
    outputTokens: base.outputTokens + event.outputTokens,
  };
  const cacheRead = (base.cacheReadTokens ?? 0) + (event.cacheReadTokens ?? 0);
  if (cacheRead > 0) next.cacheReadTokens = cacheRead;
  const cacheWrite = (base.cacheWriteTokens ?? 0) + (event.cacheWriteTokens ?? 0);
  if (cacheWrite > 0) next.cacheWriteTokens = cacheWrite;
  const model = event.model ?? base.model;
  if (model !== undefined) next.model = model;
  return next;
}

/**
 * §1.5 `error` → screen + transcript + audit. The consumer voice law (§3) makes
 * the text channel the right home for the first two: the user always sees ONE
 * assistant, and a harness `error` is already plain-language with no internals,
 * so it is the assistant speaking honestly rather than a second UI affordance.
 * Nothing new joins the wire format for it.
 */
const HARNESS_FAILED = "Something went wrong on my side, so I stopped.";

export function createHarnessRuntime(deps: HarnessRuntimeDeps): HarnessRuntime {
  const harnessState = deps.harnessState ?? memoryHarnessStateStore();

  return {
    async run<Options>(started: TurnRunInput<Options>): Promise<Response> {
      // The turn's identity, minted here because here is where a turn begins. It
      // rides the CTX rather than a second parameter, so every guarded call,
      // audit row and painted view below is joinable to this exchange for free —
      // and the rest of this function reads `input` exactly as it always did.
      const turnId = mintTurnId();
      const input: TurnRunInput<Options> = { ...started, ctx: { ...started.ctx, turnId } };
      // §1.3: what the harness may remember depends on how the history moved.
      // A prefix truncation is a native rewind, so its session survives; an
      // arbitrary edit means its session no longer describes our conversation.
      // This snapshot is also what turn-end persistence diffs against — the
      // runtime writes nothing before then, so one read serves both.
      let before: readonly UIMessage[] | undefined;
      let carried: string | undefined;
      try {
        before = await deps.transcript.list(input.ctx.principal, input.threadId);
        // A client-sourced history is not trusted history. The shipped rule
        // (`validateUpsert`) is the one that decides what a caller may change:
        // fresh USER messages, and answering a pending approval. Anything else —
        // an assistant message the client authored, a rewritten past turn — is a
        // history-forging attempt and must not reach the model or the store.
        const persisted = [...before];
        for (const message of input.messages) {
          validateUpsert(persisted, message);
          const at = persisted.findIndex((candidate) => candidate.id === message.id);
          if (at === -1) persisted.push(message);
          else persisted[at] = message;
        }
        // Classified BEFORE our own flip below, or the runtime's housekeeping
        // would read as the user rewriting history and clear the session.
        if (classifyHistory(before, input.messages) !== "arbitrary-edit") {
          carried = await harnessState.get(input.threadId, input.harness.name);
        } else {
          // §1.3: the harness's session no longer describes our conversation.
          await harnessState.clear(input.threadId);
        }
      } catch (error) {
        if (error instanceof VendoError) throw error;
        // An unreadable history is not a licence to hand over a stale session.
        carried = undefined;
      }
      const state = createTurnState(carried);
      // What persistence diffs against. Taken BEFORE the harness runs and never
      // handed out, so a harness cannot make its own edit look like it was
      // already stored — and BEFORE the flip, so the flip itself persists.
      const pristine = before === undefined ? [] : before.map((message) => structuredClone(message));

      // The canonical transcript for this turn: our copy, so the flip below never
      // mutates the caller's objects.
      const messages = input.messages.map((message) => structuredClone(message));
      // self-serve P: a retry CONTINUES the failed turn's trailing assistant
      // message, so its notice has to go before the real answer is appended
      // under it. Done on our copy, which is also what persistence diffs against
      // `pristine` — so the cleared message is written back over the stored row.
      // `before` is passed because a `regenerate()` posts the history WITHOUT the
      // message it is replacing: the record to clear is only in the store.
      clearFailedTurnRecord(messages, before ?? []);
      // The shipped rule (agent.ts `abandonPendingApprovals`): an approval a fresh
      // turn superseded resolves to its abandoned state. Resolving only the GUARD
      // side would leave the PART at `approval-requested` forever, and
      // `turnModelMessages` would then hand the provider an assistant tool-call
      // with no tool-result — a 400 on this turn and every later one, which is
      // exactly the swap-resuming-from-our-transcript case.
      await abandonStaleApprovals(deps.guard, input, messages);

      // ONE frozen copy of the canonical transcript serves both `turn.messages`
      // and `ctx.messages` — the accessor guards and judges read (RunContext,
      // agents spec 2026-08-04). Attached HERE because the runtime is where the
      // resolved thread and the ctx first meet; the ctx the wire built has no
      // thread yet. In-process only: everything persisted stays an explicit
      // data projection.
      const transcriptView = deepFreeze(messages.map((message) => structuredClone(message)));
      const ctx: RunContext = { ...input.ctx, messages: () => transcriptView };

      const signal = input.signal ?? new AbortController().signal;
      let usage: UsageTotals | undefined;
      let failure: { message: string; code?: string } | undefined;
      /** The last message we deliberately put on the error channel, so the
       *  stream's own onError does not log it again. */
      let surfaced: string | undefined;
      /** self-serve P: the writer, reachable from the stream's own onError so a
       *  failure thrown BEFORE (or outside) the harness loop is recorded in the
       *  turn too, instead of persisting a blank assistant reply. */
      let turnWriter: UIMessageStreamWriter<UIMessage> | undefined;
      /** ONE notice per turn, from whichever path sees the failure first — a turn
       *  can only fail once. Needed because the stream's onError runs again for
       *  the very error chunk we deliberately wrote. */
      let turnErrorRecorded = false;
      const recordTurnError = (message: string, write: (part: unknown) => void): void => {
        if (turnErrorRecorded) return;
        turnErrorRecorded = true;
        writeTurnError(write, message);
      };

      // The capability-miss rail, built here because the detector needs the
      // resolved ctx. `available` bounds a report's `toolsConsidered` to the
      // projected surface, resolved only when a miss is actually reported.
      const capabilityMiss = input.capabilityMiss === undefined
        ? undefined
        : createCapabilityMissDetector({
            config: input.capabilityMiss.config,
            ctx,
            intent: input.capabilityMiss.intent,
            ...(input.capabilityMiss.threadId === undefined
              ? {}
              : { threadId: input.capabilityMiss.threadId }),
            available: async () =>
              new Set((await deps.tools.descriptors(ctx)).map((descriptor) => descriptor.name)),
          });

      // A harness turn stays OPEN while a call is parked, so `onFinish` is much
      // too late to be this turn's only save: until the tap comes there is
      // nothing in the transcript saying the agent ever asked. Reload in that
      // window — the ai-SDK path's normal shape, since IT ends the turn at the
      // park — and the card is gone with no way to get it back.
      //
      // So the parked message is checkpointed the moment it parks. The id is
      // pinned rather than generated, so `onFinish` upserts OVER this row
      // instead of leaving a second copy of the same reply. (`generateId` is
      // called exactly once by the SDK, for the response message id.)
      //
      // A transcript that ENDS in an assistant message is one the SDK continues
      // instead — it ignores `generateId` and reuses that message's id — so the
      // checkpoint has to be the same message, or a turn that parks during a
      // retry checkpoints under an id `onFinish` never writes.
      const continued = messages.at(-1)?.role === "assistant" ? messages.at(-1) : undefined;
      const assistantMessageId = continued?.id ?? globalThis.crypto.randomUUID();
      /** Calls already checkpointed — a turn can park more than once, and the
       *  second ask deserves the save the first one got. */
      const checkpointed = new Set<string>();

      /** The harness's mid-turn ear, if it registered one (§1 `Turn.onSteer`). */
      let steerHandler: ((text: string) => Promise<boolean>) | undefined;
      /**
       * The user's words, mid-turn.
       *
       * Appending to the CANONICAL array is the whole mechanism, and it is load
       * bearing. `persistTurn` writes one row per message at ITS INDEX in this
       * array; a side-channel write straight to the store cannot know that index,
       * so it lands at the seq the ASSISTANT message will claim — and `seq` is the
       * transcript's only ordering authority (store `schema.ts`: one index, no
       * tiebreak). Measured: two rows at one seq, so the user's steer and the
       * reply it caused have no defined order. Joining the turn's own list instead
       * means the existing turn-end pass persists it, once, in place.
       *
       * BEFORE the assistant's reply, never after: the reply is appended by the
       * stream at finish, so the transcript reads ask · ask again · answer — and
       * the live client can match that order exactly.
       */
      const steer = async (text: string, messageId: string): Promise<boolean> => {
        // Not registering IS the answer. No capability protocol, nothing to ask.
        if (steerHandler === undefined) return false;
        if (!await steerHandler(text)) return false;
        messages.push({ id: messageId, role: "user", parts: [{ type: "text", text }] });
        return true;
      };

      const stream = createUIMessageStream<UIMessage>({
        originalMessages: messages,
        generateId: () => assistantMessageId,
        execute: async ({ writer }) => {
          turnWriter = writer;
          // The dev-only diagnostics channel, open for exactly this turn. Off
          // (the production case) this registers nothing and every emit below —
          // here, in the loop, in the guarded-call path — is a map miss.
          const closeWorkbench = openWorkbench(turnId, (part) => writeDebug(writer, part));
          const text = new TextChannel(writer);
          const mirror = (event: MirrorEvent): void => {
            // Close the open text part first, so a reply that spans tool calls
            // renders as prose, tool, prose instead of collapsing into one block.
            if (event.kind === "call") text.break();
            writeMirror(writer, event);
          };
          const tools = createTurnTools({
            registry: deps.tools,
            guard: deps.guard,
            ctx,
            interactive: input.interactive,
            mirror,
            // The shipped bridge's rails ride along: the writer every
            // `data-vendo-*` part goes to (view, approval, connect, build-failed,
            // citations), `toolOutputCap`, the connect gate, the capability-miss
            // hook, and a FRESH per-turn connect-card dedupe set.
            // The capability-miss hook rides the bridge: a tool that fails twice
            // in one turn reports itself, wherever the failure came from.
            bridge: {
              ...deps.bridge,
              ...(capabilityMiss === undefined ? {} : { onCall: capabilityMiss.onCall }),
              writer,
              connectCards: new Set<string>(),
            },
            ...(capabilityMiss === undefined ? {} : { capabilityMiss: capabilityMiss.reporter }),
            // §1 amendment 2026-08-03: the harness's own say over the surface —
            // which names it never sees (withhold).
            ...(input.harness.toolSurface === undefined
              ? {}
              : { toolSurface: input.harness.toolSurface }),
            ...(deps.approvalWaitMs === undefined ? {} : { approvalWaitMs: deps.approvalWaitMs }),
          });

          // The injected workspace wrap — composition wires the render seam in
          // here, so every commit that lands a hot-path file goes on screen
          // (§1.6), whichever hands wrote it. Unwired, the workspace passes
          // through untouched.
          const workspace = deps.wrapWorkspace?.(input.workspace, {
            emit: (_streamId, part) => writeView(writer, part as never),
            turnId,
          }) ?? input.workspace;

          /** For in-process hands, write IS commit: the façade stages writes, so
           *  nothing is durable — or on screen — until this runs. `/user` is
           *  last-write-wins, and a commit with nothing staged is a no-op, so
           *  calling it liberally is cheap. */
          const commit = async (): Promise<void> => {
            try {
              await workspace.commit();
            } catch (error) {
              // A failed commit is the harness's to notice through its next read;
              // it must never take down a turn that already has a reply.
              console.error("[vendo] harness runtime: workspace commit failed", {
                threadId: input.threadId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          };

          const turn: Turn<Options> = {
            // Frozen: ours, read-only. Freezing makes the contract's word true at
            // runtime instead of only at compile time.
            messages: transcriptView,
            tools: {
              list: () => tools.list(),
              // A workspace tool edit lands the moment it returns, so the
              // skeleton appears on save rather than at turn end.
              call: async (name, args) => {
                const result = await tools.call(name, args);
                await commit();
                return result;
              },
            },
            skills: deps.skills,
            workspace,
            models: input.models ?? {},
            state,
            options: input.options as Options,
            signal,
            interactive: input.interactive,
            ...(input.system === undefined ? {} : { system: input.system }),
            threadId: input.threadId,
            turnId,
            // §1 amendment 2026-08-05: inbound control, and the only one beside
            // `signal`. At most one handler — a turn has one thinker.
            onSteer: (handler) => { steerHandler = handler; },
          };

          // Published for the process's own doors (the MCP door's turn
          // credential). The SAME `turn.tools` value the harness holds, so a
          // call arriving over the door is the call the harness would have made.
          const unpublish = deps.liveTurn?.({
            threadId: input.threadId,
            ctx,
            tools: turn.tools,
            steer,
          });

          try {
            for await (const event of input.harness.run(turn)) {
              switch (event.type) {
                case "text":
                  text.delta(event.delta);
                  break;
                case "status":
                  writeStatus(writer, event);
                  break;
                case "error":
                  failure = { message: event.message, ...(event.code === undefined ? {} : { code: event.code }) };
                  emitWorkbench(turnId, "resident", {
                    kind: "error",
                    code: event.code ?? "harness",
                    message: event.message,
                  });
                  text.break();
                  surfaced = event.message;
                  // The TRANSCRIPT's failure affordance, and it goes FIRST. The
                  // chunk below belongs to no message, so without this the reload
                  // of a failed turn shows the question answered by a blank reply
                  // — but writing that chunk re-enters the stream's own `onError`
                  // (which knows it: see the note there), and by then this
                  // sentence is a formatted STRING, not the `VendoError` it came
                  // from. `onError` therefore records the generic constant and
                  // takes the one-per-turn slot with it, leaving the record below
                  // a no-op. The banner said "run `vendo login`" and the reload
                  // said "something went wrong". Claiming the slot first is what
                  // keeps the two the same sentence.
                  recordTurnError(event.message, (part) => writer.write(part as never));
                  // …and the SCREEN's — the same ai-SDK error chunk the legacy
                  // agent path raised, so the host renders its banner, its Retry and its
                  // detail line. Splicing the sentence into the assistant's prose
                  // instead would read as the agent talking and would offer the
                  // user nothing to act on.
                  writeError(writer, event.message);
                  break;
                case "usage":
                  // Audit/metering only — never the screen, never the transcript.
                  // A turn may yield several (the resident's own spend, then one
                  // per hired helper); they partition the turn and sum here.
                  usage = addUsage(usage, event);
                  break;
              }
            }
          } catch (error) {
            // A harness that throws is a bug in the thinker, not in the user's
            // day. The real error goes to the operator's terminal; the user gets
            // a plain sentence, and NOTHING of the internals travels.
            console.error("[vendo] harness run failed", {
              harness: input.harness.name,
              threadId: input.threadId,
              error: error instanceof Error ? error.message : String(error),
            });
            // …unless the error is one Vendo itself crafted (the credential
            // ladder's `vendo login` guidance, the Cloud meter refusal), which
            // the legacy door put in front of the user verbatim. Substituting
            // our constant for those is how a keyless deployment migrated onto
            // this path lost the one sentence that said what to do about it.
            const message = specificWireErrorMessage(error) ?? HARNESS_FAILED;
            failure = { message, code: "harness" };
            emitWorkbench(turnId, "resident", { kind: "error", code: "harness", message });
            // Same two carriers as a reported `error` event above — the screen's
            // banner/Retry and the transcript's record. A thrown failure used to
            // be spoken as prose instead, which read as the agent talking, gave
            // the user nothing to act on, and left a reload showing a blank reply.
            text.break();
            surfaced = message;
            writeError(writer, message);
            recordTurnError(message, (part) => writer.write(part as never));
          } finally {
            // FIRST: the turn is over, so the door must stop answering for it.
            // A call arriving during turn-end cleanup has nothing to be judged
            // in, and the credential resolves to nothing from here.
            unpublish?.();
            // Turn end lands everything the harness staged and never committed —
            // memory notes, uploads, a plan written straight to the workspace.
            // Inside `execute`, so a view from this commit can still reach the
            // wire; the stream is closed by the time onFinish runs.
            await commit();
            text.end();
            // An approval nobody answered would otherwise stay live-but-dead: its
            // card still on screen, its row still in the pending queue forever.
            // Resolving them denied at turn end is what today's loop does for the
            // approvals a fresh user turn supersedes.
            await abandonUnanswered(deps.guard, input, tools.unansweredApprovals());
            tools.dispose();
            closeWorkbench();
          }
        },
        onFinish: async ({ messages }) => {
          await persistTurn(deps.transcript, input, messages, pristine);
          await saveHarnessState(harnessState, input, state.pending());
          await reportRun(deps.guard, input, { usage, failure });
        },
        // The runtime's own last-resort gate for a runtime/transport fault.
        // A harness `error` event already reached the operator's terminal through
        // `wireErrorMessage`, and writing its chunk trips this hook too — so an
        // error we deliberately surfaced is NOT logged a second time here.
        onError: (error) => {
          const text = error instanceof Error ? error.message : String(error);
          if (text !== surfaced) console.error("[vendo] harness stream error:", error);
          // The record for failures the harness loop can never see: `execute`
          // itself rejecting (building the toolset, mounting the workspace,
          // minting a turn credential) — those never become a harness `error`
          // event, and they are exactly where the credential ladder's own
          // VendoErrors surface. What the USER was told is what the turn keeps:
          // Vendo's crafted sentence when there is one, the plain constant
          // otherwise, and nothing of the internals either way. The SDK's writer
          // swallows a write past close, so this is safe at any point in the
          // turn's life.
          const message = specificWireErrorMessage(error) ?? HARNESS_FAILED;
          recordTurnError(message, (part) => turnWriter?.write(part as never));
          return message;
        },
      });

      // Read a COPY of the outgoing chunks back through the SDK's own reducer,
      // so the checkpoint stores the real message — same parts, same id — rather
      // than a hand-rolled imitation that would drift from it.
      const [toClient, toCheckpoint] = stream.tee();
      void (async () => {
        try {
          for await (const message of readUIMessageStream<UIMessage>({
            message: {
              id: assistantMessageId,
              role: "assistant",
              parts: continued === undefined ? [] : structuredClone(continued.parts),
            },
            stream: toCheckpoint,
          })) {
            const parked = message.parts.filter(isParkedApproval)
              .map((part) => (part as { toolCallId: string }).toolCallId);
            if (parked.every((toolCallId) => checkpointed.has(toolCallId))) continue;
            for (const toolCallId of parked) checkpointed.add(toolCallId);
            await persistTurn(deps.transcript, input, [...messages, message], pristine);
          }
        } catch {
          // A safety net, never the turn itself: onFinish still saves, and
          // persistTurn already names a real store failure loudly.
        }
      })();

      // A harness turn can be quiet for a long time — a provider call before
      // the first token, a slow tool. The keepalive puts a first frame on the
      // wire at once and punctuates the silence, without touching the message
      // sequence (SSE comment frames; see core/sse-keepalive.ts).
      return withSseKeepalive(createUIMessageStreamResponse({ stream: toClient }));
    },
  };
}

/**
 * States that mean "the call was announced and never resolved". A turn that ended
 * mid-call (an abort inside a tool, a harness that stopped awaiting) leaves one,
 * and `convertToModelMessages` turns it into an assistant tool-call with no
 * matching tool-result — which providers reject, corrupting every later turn on
 * the thread.
 *
 * `approval-requested` is deliberately NOT here: a call waiting on a human is
 * legitimately pending, and the client flips it. Only the unreachable states go.
 */
const DANGLING_TOOL_STATES = new Set(["input-streaming", "input-available"]);

const isToolPart = (part: { type: string }): boolean =>
  part.type === "dynamic-tool" || part.type.startsWith("tool-");

/** A call the turn is holding open on a human. */
const isParkedApproval = (part: { type: string }): boolean =>
  isToolPart(part) && (part as { state?: string }).state === "approval-requested";

/**
 * Enforce the result-pairing invariant instead of racing for it. The shipped loop
 * happens to win this race by a microtask (see abort.test.ts, which pins the
 * timing); dropping the part here makes the guarantee independent of who wins.
 */
function withoutDanglingToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const kept = message.parts.filter(
      (part) => !(isToolPart(part) && DANGLING_TOOL_STATES.has((part as { state?: string }).state ?? "")),
    );
    return kept.length === message.parts.length ? message : { ...message, parts: kept };
  });
}

// ENG-309: backoff between persist attempts after a completed stream. Short and
// bounded — long waits would hold the response open for nothing (the user
// already has the reply); a store blip that outlives ~600ms is a real outage.
const PERSIST_RETRY_DELAYS_MS = [100, 500] as const;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build contract §6 + the store write law: one row per NEW OR EDITED message,
 * ordered by `seq`, never by timestamp. Re-sending an untouched history costs
 * nothing, so a turn lands O(messages changed) rows — not O(thread), and never
 * O(tokens).
 */
async function persistTurn(
  transcript: TranscriptStore,
  input: TurnRunInput<unknown>,
  rawMessages: UIMessage[],
  before: readonly UIMessage[] | undefined,
): Promise<void> {
  const messages = withoutDanglingToolCalls(rawMessages);
  const unchanged = new Map(
    (before ?? []).map((message) => [message.id, JSON.stringify(message)]),
  );
  // ENG-309: a store blip must not cost the turn. Each attempt re-walks the
  // whole diff — `upsert` is per-row and idempotent for an unchanged row, so a
  // partial first pass costs a repeat write, never a corrupted thread.
  for (let attempt = 0; ; attempt += 1) {
    try {
      for (const [seq, message] of messages.entries()) {
        if (unchanged.get(message.id) === JSON.stringify(message)) continue;
        await transcript.upsert(input.ctx.principal, input.threadId, message, seq);
      }
      return;
    } catch (error) {
      const delay = PERSIST_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        // By the time onFinish runs the reply is already on the wire, so throwing
        // here would corrupt a delivered stream. A thread silently vanishing after a
        // successful reply is data loss, so it is named LOUDLY instead.
        console.error("[vendo] harness runtime: transcript persist failed — this turn was NOT saved", {
          threadId: input.threadId,
          subject: input.ctx.principal.subject,
          attempts: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      await wait(delay);
    }
  }
}

async function saveHarnessState(
  store: HarnessStateStore,
  input: TurnRunInput<unknown>,
  pending: { value: string | undefined; dirty: boolean },
): Promise<void> {
  if (!pending.dirty) return;
  try {
    await store.set(input.threadId, input.harness.name, pending.value);
  } catch (error) {
    // `turn.state` is disposable by contract: losing it costs a re-seed, never
    // correctness, so it must never take a delivered turn down with it.
    console.error("[vendo] harness runtime: harness state not saved", {
      threadId: input.threadId,
      harness: input.harness.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The turn's metering row — `audit ⊇ transcript`, so billing never depends on
 * the story layer.
 *
 * ONE row per turn, and its `usage` is the turn's WHOLE spend: a harness that
 * staffs helpers yields each helper's figures as its own `usage` event and
 * `addUsage` folds them all here — the same blended reporting a claude-code box
 * gives. The per-hire receipt path (a `subagent` row per helper) is gone with
 * the de-brain refactor: staffing is the brain's strategy, and the meter reads
 * tokens, not org charts.
 */
async function reportRun(
  guard: Guard,
  input: TurnRunInput<unknown>,
  detail: {
    usage: UsageTotals | undefined;
    failure: { message: string; code?: string } | undefined;
  },
): Promise<void> {
  if (detail.usage === undefined && detail.failure === undefined) return;
  const event: AuditEvent = {
    id: mintAuditId(),
    at: new Date().toISOString(),
    kind: "run",
    ...auditContext(input.ctx),
    detail: {
      harness: input.harness.name,
      ...(detail.usage === undefined ? {} : { usage: detail.usage }),
      ...(detail.failure === undefined ? {} : { error: detail.failure }),
    },
  };
  try {
    await guard.report(event);
  } catch {
    // A reporting failure cannot change a completed turn's result.
  }
}


/**
 * Flip stale `approval-requested` parts and resolve their guard-side approvals —
 * the shipped `abandonPendingApprovals` semantics, applied by the runtime so a
 * harness turn leaves the same paired history the legacy agent path produced.
 */
async function abandonStaleApprovals(
  guard: Guard,
  input: TurnRunInput<unknown>,
  messages: UIMessage[],
): Promise<void> {
  const toolCallIds = abandonPendingApprovals(messages);
  if (toolCallIds.length === 0) return;
  // The GUARD's approvalId rides the `data-vendo-approval` part beside the tool
  // part, keyed by toolCallId — read it from there, as the shipped loop does.
  const ids = guardApprovalIds(messages, toolCallIds);
  if (ids.length === 0 || guard.abandonApprovals === undefined) return;
  try {
    await guard.abandonApprovals(ids, input.ctx);
  } catch {
    // The transcript already reflects abandonment; the guard method is
    // idempotent, so cleanup retries on the next abandoned turn.
  }
}

/**
 * Resolve the approvals this turn raised and nobody answered. Best-effort and
 * idempotent, exactly like the shipped abandonment path: a failed guard write
 * retries implicitly the next time a turn abandons, and it must never take down a
 * turn that already has a reply.
 */
async function abandonUnanswered(
  guard: Guard,
  input: TurnRunInput<unknown>,
  ids: ApprovalId[],
): Promise<void> {
  if (ids.length === 0 || guard.abandonApprovals === undefined) return;
  try {
    await guard.abandonApprovals(ids, input.ctx);
  } catch {
    // The card is already dead to this turn; queue cleanup retries later.
  }
}
