import {
  VendoError,
  toVendoWirePart,
  type AgentRunner,
  type ApprovalId,
  type Guard,
  type RunContext,
  type StoreAdapter,
  type ThreadId,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  isToolUIPart,
  type LanguageModel,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import { startTurn } from "./loop.js";
import { wireErrorMessage } from "./wire-error.js";
import { assembleSystemPrompt } from "./prompt.js";
import { createRunner } from "./runner.js";
import { ThreadRepository, type Thread, type ThreadSummary } from "./threads.js";
import { addAgentTool, buildAgentTools } from "./tools.js";
import {
  createCapabilityMissDetector,
  latestUserIntent,
  type CapabilityMissConfig,
} from "./capability-miss.js";
import { createToolSearchSession, type ToolSearchConfig } from "./tool-search.js";

/** The effective thread id every turn response carries (03 §1), so a caller
 *  that began without one can adopt it. Exported through `@vendoai/agent/internal`
 *  because a composition serving turns through the harness runtime must stamp the
 *  SAME header — the wire reads it to register turn liveness. */
export const THREAD_ID_HEADER = "x-vendo-thread-id";

// ENG-309: backoff between persist attempts after a completed stream. Short and
// bounded — long waits would hold the response open for nothing (the user
// already has the reply); a store blip that outlives ~600ms is a real outage.
const PERSIST_RETRY_DELAYS_MS = [100, 500] as const;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ENG-309: persist the finished turn with bounded retry, and surface a final
 *  failure LOUDLY instead of swallowing it. By the time onFinish runs, the
 *  response headers and the SSE `[DONE]` are already on the wire, so no
 *  additive wire signal can reach this turn's client — never throw here (that
 *  would corrupt the already-delivered stream / crash the transport), but a
 *  thread silently vanishing after a successful reply is data loss, so the
 *  structured error names the thread. */
async function persistFinishedTurn(
  threads: ThreadRepository,
  thread: Thread,
  messages: UIMessage[],
  ctx: RunContext,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await threads.persist(thread, messages);
      return;
    } catch (error) {
      const delay = PERSIST_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.error(
          "[vendo] agent: thread persist failed after completed stream — this turn was NOT saved",
          {
            threadId: thread.id,
            subject: ctx.principal.subject,
            attempts: attempt + 1,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return;
      }
      await wait(delay);
    }
  }
}

interface AgentConfig {
  model: LanguageModel;
  tools: ToolRegistry;
  guard: Guard;
  store?: StoreAdapter;
  system?: {
    /** The host product brief. The provider form (cse lane 3) is re-read
     *  per-turn (assembleSystemPrompt), so a cloud-backed brief resolves LIVE. */
    product?: string | (() => string | undefined);
    /** AGENT-1 (03 §3 item 4): catalog + theme summary, assembled by the
     *  umbrella; injected only for venues that render trees. */
    catalog?: string;
    /** Knowledge k8 (ENG-368): static knowledge index + usage guidance,
     *  assembled by the umbrella at boot (locked — never per-turn, so the
     *  prompt stays cache-stable); venue-gated like the catalog. */
    knowledge?: string | (() => string | undefined | Promise<string | undefined>);
    instructions?: string;
  };
  context?: {
    maxOutputTokens?: number;
    toolOutputCap?: number;
    /** Bound the messages re-sent to the model per turn to the last N (whole messages,
     *  so tool-call/result pairing inside a message is never split). Undefined → send the
     *  full thread (current behavior). Persistence and the streamed thread are unaffected. */
    historyWindow?: number;
    /** AGENT-7: the agent-loop step cap (default 20). Exhausting it is VISIBLE:
     *  the stream carries a `data-vendo-step-limit` part the client can render. */
    maxSteps?: number;
  };
  capabilityMiss?: CapabilityMissConfig;
  /** ENG-252: enable the `find_tools` meta-tool and runtime loadout.
   *  When set, the model starts with a bounded initial loadout and discovers the
   *  rest through search; searched-in tools execute through the same guard-bound
   *  registry as any initially-enabled tool. */
  toolSearch?: ToolSearchConfig;
  /** Discovery-discipline 2026-07-25: a pre-guard short-circuit. A non-undefined
   *  outcome (the umbrella wires the connect gate's check) means the call will
   *  not run — needsApproval must NOT consult the guard (no approval minted);
   *  execute() returns the outcome from the (gate-wrapped) registry instead. */
  preflight?: (call: ToolCall, ctx: RunContext) => Promise<ToolOutcome | undefined>;
  /** Tour mode's hook — the scripted-turn seam. Consulted once per turn, after
   *  the thread is resolved and this message upserted into it, before any model
   *  work: returning a play REPLACES the provider call for this turn, returning
   *  undefined leaves the turn untouched.
   *
   *  It lives here rather than in the umbrella because everything a scripted
   *  turn must share with a live one is here: the resolved thread (which is how
   *  a tour knows what has already played), the persistence in `onFinish`
   *  (which is what makes a scripted turn editable by the next, live one), and
   *  the response contract. A seam in the wire route would have to rebuild all
   *  three and could only ever approximate them.
   *
   *  The umbrella owns what a play IS (createVendo's `tours`): matching and
   *  replay need the apps runtime, and the layering forbids this package from
   *  seeing it. */
  scripted?: (input: {
    message: UIMessage;
    /** The thread as the turn sees it, `message` already upserted. */
    messages: readonly UIMessage[];
    ctx: RunContext;
  }) => Promise<ScriptedTurn | undefined>;
}

/** One scripted turn's body: everything it writes goes onto the same stream a
 *  live turn writes to, and is persisted by the same `onFinish`. */
export type ScriptedTurn = (input: {
  writer: UIMessageStreamWriter<UIMessage>;
  signal?: AbortSignal;
}) => Promise<void>;

/** 03-agent §1 */
export interface VendoAgent {
  /** AGENT-3: `signal` cancels the turn — provider calls stop (the in-flight
   *  call is aborted, no further step starts) and the thread persists in a
   *  consistent, resumable state. The umbrella wires client disconnect here. */
  stream(input: {
    threadId?: ThreadId;
    message: UIMessage;
    ctx: RunContext;
    signal?: AbortSignal;
  }): Promise<Response>;
  threads: {
    get(id: ThreadId, ctx: RunContext): Promise<Thread | null>;
    list(ctx: RunContext): Promise<ThreadSummary[]>;
    delete(id: ThreadId, ctx: RunContext): Promise<void>;
  };
  /** ENG-237 (AGENT-11): drop a subject's in-memory threads when its ephemeral
   *  session is evicted. The umbrella calls this for every subject the store's
   *  idle sweep returns; store-backed threads live in the store overlay (already
   *  cascaded), so this only bites the no-store (BYO) composition. */
  evictSubject(subject: string): void;
  asRunner(): AgentRunner;
}

function validateConfig(config: AgentConfig): void {
  const { maxOutputTokens, toolOutputCap, historyWindow } = config.context ?? {};
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) {
    throw new VendoError("validation", "maxOutputTokens must be a positive integer");
  }
  if (toolOutputCap !== undefined && (!Number.isInteger(toolOutputCap) || toolOutputCap < 0)) {
    throw new VendoError("validation", "toolOutputCap must be a non-negative integer");
  }
  if (historyWindow !== undefined && (!Number.isInteger(historyWindow) || historyWindow < 1)) {
    throw new VendoError("validation", "historyWindow must be a positive integer");
  }
  const { maxSteps } = config.context ?? {};
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
    throw new VendoError("validation", "maxSteps must be a positive integer");
  }
}

// System-role messages are rejected: the system prompt is assembled server-side
// (03 §3); accepting one from the client would be a prompt-injection channel.
export function validateMessage(message: UIMessage | undefined): asserts message is UIMessage {
  if (!message
    || typeof message.id !== "string"
    || message.id.length === 0
    || !["user", "assistant"].includes(message.role)
    || !Array.isArray(message.parts)) {
    throw new VendoError("validation", "stream requires a valid message");
  }
}

export function upsertMessage(messages: UIMessage[], message: UIMessage): void {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) messages.push(message);
  else messages[index] = message;
}

/** Structural JSON equality, key-order independent (both sides are
 *  wire-serializable UIMessage parts). */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => jsonEqual(leftRecord[key], rightRecord[key]));
}

/** AGENT-12: is `incoming` the one client-writable change to a stored part —
 *  answering a pending approval? The verdict payload is exactly
 *  `{ id (unchanged), approved, reason? }` and EVERY other field of the part
 *  must stay byte-identical — no fabricated output or altered props may ride
 *  along on the flip. */
function isApprovalResponse(stored: unknown, incoming: unknown): boolean {
  const before = stored as Record<string, unknown>;
  const after = incoming as Record<string, unknown>;
  if (before.state !== "approval-requested" || after.state !== "approval-responded") return false;
  const beforeApproval = before.approval as { id?: unknown } | undefined;
  const afterApproval = after.approval as Record<string, unknown> | undefined;
  if (beforeApproval === undefined || afterApproval === undefined) return false;
  if (afterApproval.id !== beforeApproval.id
    || typeof afterApproval.approved !== "boolean"
    || (afterApproval.reason !== undefined && typeof afterApproval.reason !== "string")
    || Object.keys(afterApproval).some((key) => !["id", "approved", "reason"].includes(key))) {
    return false;
  }
  // Reverting the flip must reproduce the stored part exactly.
  return jsonEqual({ ...after, state: before.state, approval: before.approval }, before);
}

/** AGENT-12: clients may add fresh USER messages and answer approvals — they
 *  may not author assistant content or rewrite history by replaying a known
 *  message id with different parts. */
export function validateUpsert(messages: UIMessage[], message: UIMessage): void {
  const existing = messages.find((candidate) => candidate.id === message.id);
  if (existing === undefined) {
    if (message.role !== "user") {
      throw new VendoError("validation", "assistant messages are server-authored; a new message must be role user");
    }
    return;
  }
  if (existing.role !== message.role) {
    throw new VendoError("validation", "a message upsert cannot change the message role");
  }
  // Serialize both sides so explicit-undefined props (which JSON drops on the
  // wire anyway) never make an identical part read as different.
  const stored = JSON.parse(JSON.stringify(existing.parts)) as unknown[];
  const incoming = JSON.parse(JSON.stringify(message.parts)) as unknown[];
  if (message.role === "user") {
    if (!jsonEqual(stored, incoming)) {
      throw new VendoError("validation", "an existing user message cannot be rewritten");
    }
    return;
  }
  if (stored.length !== incoming.length
    || !stored.every((part, index) => jsonEqual(part, incoming[index]) || isApprovalResponse(part, incoming[index]))) {
    throw new VendoError(
      "validation",
      "an assistant message upsert may only answer pending approvals",
    );
  }
}

export function abandonPendingApprovals(messages: UIMessage[]): string[] {
  const abandonedToolCallIds: string[] = [];
  for (const message of messages) {
    message.parts = message.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      // Parts flipped on an EARLIER turn re-collect too: guard-side resolution
      // is best-effort per turn, so a failed abandonApprovals call retries on
      // the next fresh turn (the guard method is idempotent — an
      // already-denied id is a no-op there).
      if (part.state === "approval-responded"
        && part.approval?.approved === false
        && (part.approval as { reason?: string }).reason === "abandoned") {
        abandonedToolCallIds.push(part.toolCallId);
        return part;
      }
      if (part.state !== "approval-requested") return part;
      abandonedToolCallIds.push(part.toolCallId);
      return {
        ...part,
        state: "approval-responded",
        approval: {
          id: part.approval.id,
          approved: false,
          reason: "abandoned",
        },
      };
    });
  }
  return abandonedToolCallIds;
}

/** AGENT-6: the guard's approval ids for abandoned tool calls. The native tool
 *  part's `approval.id` is the ai-SDK's own handle; the GUARD's approvalId
 *  rides the data-vendo-approval part beside it, keyed by toolCallId — read it
 *  from either the persisted nested envelope or the flat §16 shape. */
export function guardApprovalIds(messages: UIMessage[], toolCallIds: string[]): ApprovalId[] {
  if (toolCallIds.length === 0) return [];
  const wanted = new Set(toolCallIds);
  const ids: ApprovalId[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const payload = ("data" in part ? part.data : part) as { toolCallId?: unknown; approvalId?: unknown };
      if (typeof payload.toolCallId === "string" && wanted.has(payload.toolCallId)
        && typeof payload.approvalId === "string") {
        ids.push(payload.approvalId as ApprovalId);
      }
    }
  }
  return ids;
}

/** self-serve P — a new turn never inherits the LAST turn's failure notice.
 *  When the thread's final message is an assistant turn, the ai-SDK CONTINUES
 *  it (handleUIMessageStreamFinish reuses its id and seeds the new turn's state
 *  from its parts), so a retry after a failed turn would append the real answer
 *  UNDER the stale "no model key" line and persist both — the flagship keyless
 *  → `vendo login` → Retry flow, permanently wrong on every reload. Anything
 *  the failed turn actually produced (partial text, tool beats) stays.
 *
 *  The emptied message is KEPT rather than dropped: persistence merges a turn
 *  into the stored row by message id (mergeMessages in threads.ts) and can only
 *  add or replace, never remove. A message dropped here would simply stay in
 *  the store — the retry would look clean live and still reload with the stale
 *  notice above the answer. Left in place, the continuation reuses its id and
 *  the merge overwrites the stored copy with the real reply. */
function clearFailedTurnRecord(messages: UIMessage[]): void {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return;
  const kept = last.parts.filter((part) => part.type !== "data-vendo-turn-error");
  if (kept.length !== last.parts.length) last.parts = kept;
}

/** 03-agent §1 */
export function createAgent(config: AgentConfig): VendoAgent {
  validateConfig(config);
  // kill-list B5: a host that omits `store` still gets thread persistence —
  // core's in-memory reference StoreAdapter, scoped to this agent instance's
  // process lifetime — through the exact same ThreadRepository code path a
  // store-backed composition uses. No separate memory-only branch survives.
  const threads = new ThreadRepository(config.store ?? memoryStoreAdapter());
  // ENG-252: per-thread set of tools loaded in via `find_tools`. It
  // persists across turns within a run so a discovered tool stays callable, and
  // is reclaimed on thread delete + session eviction. The LRU cap bounds memory
  // for long-lived, store-backed processes where threads never get evicted (a
  // reused/live thread is touched to the end, so only cold threads are dropped).
  const loadedTools = new Map<string, Set<string>>();
  const MAX_LOADED_THREADS = 1024;
  const loadedFor = (threadId: string): Set<string> => {
    const existing = loadedTools.get(threadId);
    if (existing !== undefined) {
      loadedTools.delete(threadId);
      loadedTools.set(threadId, existing); // touch: most-recently-used
      return existing;
    }
    const fresh = new Set<string>();
    loadedTools.set(threadId, fresh);
    while (loadedTools.size > MAX_LOADED_THREADS) {
      const oldest = loadedTools.keys().next().value;
      if (oldest === undefined) break;
      loadedTools.delete(oldest);
    }
    return fresh;
  };
  return {
    async stream(input) {
      validateMessage(input?.message);
      const thread = await threads.resolve(input.threadId, input.ctx);
      validateUpsert(thread.messages, input.message);
      if (input.message.role === "user"
        && !thread.messages.some((message) => message.id === input.message.id)) {
        const abandonedCalls = abandonPendingApprovals(thread.messages);
        // AGENT-6: resolve the abandoned asks guard-side too (denied, no
        // grant), so the pending queue tracks the thread. Best-effort — the
        // fresh turn must stream even when the guard write fails.
        const approvalIds = guardApprovalIds(thread.messages, abandonedCalls);
        if (approvalIds.length > 0 && config.guard.abandonApprovals !== undefined) {
          try {
            await config.guard.abandonApprovals(approvalIds, input.ctx);
          } catch {
            // The thread already reflects abandonment; queue cleanup retries
            // implicitly on the next abandoned turn.
          }
        }
      }
      upsertMessage(thread.messages, input.message);
      clearFailedTurnRecord(thread.messages);
      const system = await assembleSystemPrompt(
        config.guard,
        input.ctx,
        config.system,
        config.capabilityMiss !== undefined,
        // This thinker is `vendo()`'s loadout path: its meta-tool is find_tools.
        config.toolSearch === undefined ? false : "find-tools",
      );

      // self-serve P: the writer, reachable from the stream's own onError below
      // so a failure thrown BEFORE the model stream exists (tool building,
      // descriptors, history conversion) is recorded in the turn too, instead
      // of persisting the blank assistant reply this whole lane is about.
      let turnWriter: UIMessageStreamWriter<UIMessage> | undefined;
      // ONE notice per turn, from whichever path sees the failure first — a
      // turn can only fail once. Needed because the stream's onError runs
      // TWICE per error chunk: the SDK's finish pass re-feeds the gate its own
      // `new Error(errorText)` while assembling the message to persist.
      let turnErrorRecorded = false;
      const recordTurnError = (message: string, write: (part: unknown) => void): void => {
        if (turnErrorRecorded) return;
        turnErrorRecorded = true;
        write(toVendoWirePart({ type: "data-vendo-turn-error", message }));
      };
      const stream = createUIMessageStream<UIMessage>({
        originalMessages: thread.messages,
        execute: async ({ writer }) => {
          turnWriter = writer;
          // AGENT-3: a client that disconnected before the turn started gets no
          // provider call at all — the stream closes empty but well-formed.
          if (input.signal?.aborted) return;
          // Tour mode. Ahead of every other decision because a scripted turn
          // makes none of them: no toolset is built, no system prompt is
          // assembled, no provider is called. A turn nobody scripted falls
          // through with nothing written and no trace it was offered here.
          const play = await config.scripted?.({
            message: input.message,
            messages: thread.messages,
            ctx: input.ctx,
          });
          if (play !== undefined) {
            await play({ writer, ...(input.signal === undefined ? {} : { signal: input.signal }) });
            return;
          }
          const missDetector = config.capabilityMiss === undefined
            ? undefined
            : createCapabilityMissDetector({
                config: config.capabilityMiss,
                ctx: input.ctx,
                threadId: thread.id,
                intent: latestUserIntent(thread.messages),
              });
          // Connection-scoped loadout (spec 2026-07-20): resolve + expand the
          // principal's connected toolkits FIRST so the built toolset includes
          // them; a failed seed degrades to the risk/name fallback, never the
          // turn.
          let seedNames: string[] | undefined;
          if (config.toolSearch?.seed !== undefined) {
            try {
              seedNames = await config.toolSearch.seed(input.ctx);
            } catch {
              seedNames = undefined;
            }
          }
          // The host's curated surface menu, resolved beside the seed. A failure
          // degrades to unrestricted (the composition seam owns the warning);
          // an empty menu is a real answer and must not read as "unrestricted".
          let menuNames: readonly string[] | undefined;
          if (config.toolSearch?.menu !== undefined) {
            try {
              menuNames = await config.toolSearch.menu(input.ctx);
            } catch {
              menuNames = undefined;
            }
          }
          const bridgeOptions = {
            registry: config.tools,
            guard: config.guard,
            ctx: input.ctx,
            writer,
            toolOutputCap: config.context?.toolOutputCap,
            ...(missDetector === undefined ? {} : { onCall: missDetector.onCall }),
            ...(config.preflight === undefined ? {} : { preflight: config.preflight }),
            // Fresh per turn: one connect card per unconnected service.
            connectCards: new Set<string>(),
          };
          const tools = await buildAgentTools(bridgeOptions);
          missDetector?.attach(tools);
          const toolSearch = config.toolSearch === undefined
            ? undefined
            : createToolSearchSession({
                config: config.toolSearch,
                // Per-subject connection state annotates search results.
                ctx: input.ctx,
                // THE LAW's projection (design §12): an unattended turn is
                // never even offered a destructive or external tool.
                descriptors: await config.tools.descriptors(input.ctx),
                loaded: loadedFor(thread.id),
                ...(seedNames === undefined ? {} : { seedNames }),
                ...(menuNames === undefined ? {} : { menuNames }),
                // Search hits expanded mid-turn resolve to full descriptors and
                // materialize into the LIVE toolset — prepareStep re-reads the
                // active names each step, so they are callable next step.
                // Search must not be a way back to a withheld tool, so the
                // same projection applies to what it can resolve.
                resolve: async (names) => (await config.tools.descriptors(input.ctx)).filter((d) => names.includes(d.name)),
                materialize: (descriptor) => addAgentTool(tools, descriptor, bridgeOptions),
              });
          toolSearch?.attach(tools);
          // The shared turn loop (loop.ts) — the same call the harness lift
          // drives. History windowing, cache breakpoints, the step cap,
          // buildFailedStop and the tool-search loadout all live there, so this
          // caller and `vendo()` can never drift apart on them.
          const loop = await startTurn({
            model: config.model,
            system,
            messages: thread.messages,
            tools,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            ...(config.context === undefined ? {} : { context: config.context }),
            ...(toolSearch === undefined ? {} : { toolSearch }),
          });
          // self-serve P: the ai-SDK `error` chunk is TRANSIENT — it sets the
          // client's `error` and belongs to no message, so a failed turn
          // persisted (and reloaded) as a blank assistant reply. The gated
          // string is written into the turn as well, so the thread keeps a
          // record of why the answer never came.
          //
          // Tapped off the CHUNKS, never off `onError`: onError is the SDK's
          // general error-TEXT formatter and also runs for the recoverable
          // `tool-input-error` / `tool-output-error` chunks (a hallucinated
          // tool name, args that miss the schema — the SDK feeds those back and
          // the model retries and finishes). Hooking it stamped permanent
          // failure notices onto turns that went on to answer fine.
          writer.merge(loop.result.toUIMessageStream({
            originalMessages: thread.messages,
            // Raw provider/model error strings never reach the wire (they can
            // carry request internals); the error part is a fixed generic message.
            onError: (error) => wireErrorMessage(error),
          }).pipeThrough(new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === "error") {
                recordTurnError(chunk.errorText, (part) => controller.enqueue(part as never));
              }
              controller.enqueue(chunk);
            },
          })));
          // AGENT-7: exhausting the step cap is VISIBLE. A run that still wants
          // tool calls after its final permitted step ended because of the cap,
          // not because the model finished — stream a renderable notice.
          const stepLimit = await loop.stepLimitPart();
          if (stepLimit !== undefined) writer.write(toVendoWirePart(stepLimit) as never);
        },
        onFinish: async ({ messages }) => {
          await persistFinishedTurn(threads, thread, messages, input.ctx);
        },
        onError: (error) => {
          const message = wireErrorMessage(error);
          // The record for failures the tap above can never see: `execute`
          // itself rejecting (tool building, descriptors, history conversion)
          // — those never become a model-stream chunk. Tapped failures reach
          // here too, one beat later; the once-guard keeps the first write.
          // The SDK's writer swallows a write past close, so this is safe at
          // any point in the turn's life.
          recordTurnError(message, (part) => turnWriter?.write(part as never));
          return message;
        },
      });
      const response = createUIMessageStreamResponse({ stream });
      // ENG-211: a caller may begin without an id, in which case resolve()
      // mints one. Return the effective id on every turn so fetch clients can
      // adopt it without changing the ai-SDK SSE part contract.
      response.headers.set(THREAD_ID_HEADER, thread.id);
      return response;
    },
    threads: {
      get: (id, ctx) => threads.get(id, ctx),
      list: (ctx) => threads.list(ctx),
      delete: async (id, ctx) => {
        loadedTools.delete(id);
        await threads.delete(id, ctx);
      },
    },
    evictSubject: (subject) => {
      // kill-list B5: eviction now goes through the store (threads.evictSubject
      // is async — a list+delete against the store), so
      // this stays fire-and-forget to keep the public signature synchronous
      // (03-agent §1). Release each evicted thread's searched-in loadout so a
      // reused id can't inherit stale tools, and so memory is reclaimed on
      // session sweep.
      threads.evictSubject(subject)
        .then((ids) => {
          for (const id of ids) {
            loadedTools.delete(id);
          }
        })
        .catch((error: unknown) => {
          console.error("[vendo] agent: evictSubject failed", {
            subject,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    asRunner: () => createRunner(config),
  };
}
