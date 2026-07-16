import {
  VendoError,
  toVendoWirePart,
  type AgentRunner,
  type ApprovalId,
  type Guard,
  type RunContext,
  type StoreAdapter,
  type ThreadId,
  type ToolRegistry,
} from "@vendoai/core";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isToolUIPart,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { assembleSystemPrompt } from "./prompt.js";
import { createRunner } from "./runner.js";
import { ThreadRepository, type Thread, type ThreadSummary } from "./threads.js";
import { buildAgentTools } from "./tools.js";
import {
  createCapabilityMissDetector,
  latestUserIntent,
  type CapabilityMissConfig,
} from "./capability-miss.js";
import { createToolSearchSession, type ToolSearchConfig } from "./tool-search.js";

const THREAD_ID_HEADER = "x-vendo-thread-id";

// AGENT-7: the default agent-loop step cap (unchanged from the previously
// hardcoded value); hosts raise or lower it via context.maxSteps.
const DEFAULT_MAX_STEPS = 20;

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
      await threads.persist(thread, messages, ctx);
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
    product?: string;
    /** AGENT-1 (03 §3 item 4): catalog + theme summary, assembled by the
     *  umbrella; injected only for venues that render trees. */
    catalog?: string;
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
  /** ENG-252: enable the `vendo_tools_search` meta-tool and runtime loadout.
   *  When set, the model starts with a bounded initial loadout and discovers the
   *  rest through search; searched-in tools execute through the same guard-bound
   *  registry as any initially-enabled tool. */
  toolSearch?: ToolSearchConfig;
}

// Anthropic prompt-caching breakpoint. providerOptions.anthropic is ignored by every
// other provider (and by the test mocks), so marking breakpoints degrades to a no-op.
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

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
function validateMessage(message: UIMessage | undefined): asserts message is UIMessage {
  if (!message
    || typeof message.id !== "string"
    || message.id.length === 0
    || !["user", "assistant"].includes(message.role)
    || !Array.isArray(message.parts)) {
    throw new VendoError("validation", "stream requires a valid message");
  }
}

function upsertMessage(messages: UIMessage[], message: UIMessage): void {
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
 *  answering a pending approval? Identity fields (type, toolCallId, toolName,
 *  input) must survive untouched; only state flips to approval-responded with
 *  a boolean verdict on the SAME native approval id. */
function isApprovalResponse(stored: unknown, incoming: unknown): boolean {
  const before = stored as Record<string, unknown>;
  const after = incoming as Record<string, unknown>;
  if (before.state !== "approval-requested" || after.state !== "approval-responded") return false;
  if (after.type !== before.type || after.toolCallId !== before.toolCallId) return false;
  if ("toolName" in before && after.toolName !== before.toolName) return false;
  if (!jsonEqual(after.input, before.input)) return false;
  const beforeApproval = before.approval as { id?: unknown } | undefined;
  const afterApproval = after.approval as { id?: unknown; approved?: unknown } | undefined;
  return beforeApproval !== undefined
    && afterApproval !== undefined
    && afterApproval.id === beforeApproval.id
    && typeof afterApproval.approved === "boolean";
}

/** AGENT-12: clients may add fresh USER messages and answer approvals — they
 *  may not author assistant content or rewrite history by replaying a known
 *  message id with different parts. */
function validateUpsert(messages: UIMessage[], message: UIMessage): void {
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

function abandonPendingApprovals(messages: UIMessage[]): string[] {
  const abandonedToolCallIds: string[] = [];
  for (const message of messages) {
    message.parts = message.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== "approval-requested") return part;
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
function guardApprovalIds(messages: UIMessage[], toolCallIds: string[]): ApprovalId[] {
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

function providerHistory(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolUIPart(part)
        || part.state !== "approval-responded"
        || part.approval.approved !== false
        || part.approval.reason !== "abandoned") {
        return part;
      }
      return {
        ...part,
        state: "output-denied",
        approval: { ...part.approval, approved: false },
      };
    }),
  }));
}

/** 03-agent §1 */
export function createAgent(config: AgentConfig): VendoAgent {
  validateConfig(config);
  const threads = new ThreadRepository(config.store);
  // ENG-252: per-thread set of tools loaded in via `vendo_tools_search`. It
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
      const system = await assembleSystemPrompt(
        config.guard,
        input.ctx,
        config.system,
        config.capabilityMiss !== undefined,
      );

      const stream = createUIMessageStream<UIMessage>({
        originalMessages: thread.messages,
        execute: async ({ writer }) => {
          // AGENT-3: a client that disconnected before the turn started gets no
          // provider call at all — the stream closes empty but well-formed.
          if (input.signal?.aborted) return;
          const missDetector = config.capabilityMiss === undefined
            ? undefined
            : createCapabilityMissDetector({
                config: config.capabilityMiss,
                ctx: input.ctx,
                threadId: thread.id,
                intent: latestUserIntent(thread.messages),
              });
          const tools = await buildAgentTools({
            registry: config.tools,
            guard: config.guard,
            ctx: input.ctx,
            writer,
            toolOutputCap: config.context?.toolOutputCap,
            ...(missDetector === undefined ? {} : { onCall: missDetector.onCall }),
          });
          missDetector?.attach(tools);
          const toolSearch = config.toolSearch === undefined
            ? undefined
            : createToolSearchSession({
                config: config.toolSearch,
                descriptors: await config.tools.descriptors(),
                loaded: loadedFor(thread.id),
              });
          toolSearch?.attach(tools);
          // History windowing: bound what is re-sent per turn to the last N whole messages.
          // Slicing whole UIMessages keeps each turn's tool-call/result pairing intact.
          const window = config.context?.historyWindow;
          const history = window !== undefined && thread.messages.length > window
            ? thread.messages.slice(-window)
            : thread.messages;
          const converted = (await convertToModelMessages(providerHistory(history)))
            .filter((message) => message.content.length > 0);
          // Cache the stable history prefix (everything but the final message) alongside the
          // static system prompt below, so Anthropic re-reads the cached prefix instead of
          // re-billing the whole growing thread each turn.
          if (converted.length >= 2) {
            const prefixEnd = converted[converted.length - 2] as ModelMessage;
            prefixEnd.providerOptions = { ...prefixEnd.providerOptions, ...CACHE_BREAKPOINT };
          }
          const modelMessages: ModelMessage[] = [
            { role: "system", content: system, providerOptions: CACHE_BREAKPOINT },
            ...converted,
          ];
          const maxSteps = config.context?.maxSteps ?? DEFAULT_MAX_STEPS;
          const result = streamText({
            model: config.model,
            messages: modelMessages,
            tools,
            stopWhen: stepCountIs(maxSteps),
            maxOutputTokens: config.context?.maxOutputTokens,
            // ENG-252 loadout: restrict what the model may pick to the current
            // loadout. `prepareStep` re-reads it each step so a tool loaded via
            // `vendo_tools_search` becomes callable on the very next step. This
            // gates the model's CHOICE only — every tool still executes through
            // the guard-bound registry, so there is no unguarded path.
            ...(toolSearch === undefined
              ? {}
              : {
                  activeTools: toolSearch.activeToolNames(),
                  prepareStep: () => ({ activeTools: toolSearch.activeToolNames() }),
                }),
            // AGENT-3: cancellation reaches the provider call itself; the loop
            // never starts another step once the signal fires.
            abortSignal: input.signal,
          });
          writer.merge(result.toUIMessageStream({
            originalMessages: thread.messages,
            // Raw provider/model error strings never reach the wire (they can
            // carry request internals); the error part is a fixed generic message.
            onError: () => "An error occurred while generating the response.",
          }));
          // AGENT-7: exhausting the step cap is VISIBLE. A run that still wants
          // tool calls after its final permitted step ended because of the cap,
          // not because the model finished — stream a renderable notice.
          try {
            const [finishReason, steps] = await Promise.all([result.finishReason, result.steps]);
            if (finishReason === "tool-calls" && steps.length >= maxSteps) {
              writer.write(toVendoWirePart({
                type: "data-vendo-step-limit",
                limit: maxSteps,
                message: `Stopped after reaching the ${maxSteps}-step limit for one turn. Reply to continue.`,
              }) as never);
            }
          } catch {
            // The merged stream already surfaced the run failure; the notice is
            // best-effort and must never replace or mask that error.
          }
        },
        onFinish: async ({ messages }) => {
          await persistFinishedTurn(threads, thread, messages, input.ctx);
        },
        onError: () => "An error occurred while generating the response.",
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
      // Release each evicted thread's searched-in loadout so a reused id can't
      // inherit stale tools, and so memory is reclaimed on session sweep.
      for (const id of threads.evictSubject(subject)) loadedTools.delete(id);
    },
    asRunner: () => createRunner(config),
  };
}
