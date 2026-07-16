import {
  VendoError,
  toVendoWirePart,
  type AgentRunner,
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
  stream(input: { threadId?: ThreadId; message: UIMessage; ctx: RunContext }): Promise<Response>;
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

function abandonPendingApprovals(messages: UIMessage[]): void {
  for (const message of messages) {
    message.parts = message.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== "approval-requested") return part;
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
      if (input.message.role === "user"
        && !thread.messages.some((message) => message.id === input.message.id)) {
        abandonPendingApprovals(thread.messages);
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
