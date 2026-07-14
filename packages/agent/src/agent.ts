import {
  VendoError,
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
  };
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

  return {
    async stream(input) {
      validateMessage(input?.message);
      const thread = await threads.resolve(input.threadId, input.ctx);
      if (input.message.role === "user"
        && !thread.messages.some((message) => message.id === input.message.id)) {
        abandonPendingApprovals(thread.messages);
      }
      upsertMessage(thread.messages, input.message);
      const system = await assembleSystemPrompt(config.guard, input.ctx, config.system);

      const stream = createUIMessageStream<UIMessage>({
        originalMessages: thread.messages,
        execute: async ({ writer }) => {
          const tools = await buildAgentTools({
            registry: config.tools,
            guard: config.guard,
            ctx: input.ctx,
            writer,
            toolOutputCap: config.context?.toolOutputCap,
          });
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
          const result = streamText({
            model: config.model,
            messages: modelMessages,
            tools,
            stopWhen: stepCountIs(20),
            maxOutputTokens: config.context?.maxOutputTokens,
          });
          writer.merge(result.toUIMessageStream({
            originalMessages: thread.messages,
            // Raw provider/model error strings never reach the wire (they can
            // carry request internals); the error part is a fixed generic message.
            onError: () => "An error occurred while generating the response.",
          }));
        },
        onFinish: async ({ messages }) => {
          await threads.persist(thread, messages, input.ctx);
        },
        onError: () => "An error occurred while generating the response.",
      });
      return createUIMessageStreamResponse({ stream });
    },
    threads: {
      get: (id, ctx) => threads.get(id, ctx),
      list: (ctx) => threads.list(ctx),
      delete: (id, ctx) => threads.delete(id, ctx),
    },
    asRunner: () => createRunner(config),
  };
}
