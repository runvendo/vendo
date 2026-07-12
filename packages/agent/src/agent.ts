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
  stepCountIs,
  streamText,
  type LanguageModel,
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
  };
}

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
  const { maxOutputTokens, toolOutputCap } = config.context ?? {};
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) {
    throw new VendoError("validation", "maxOutputTokens must be a positive integer");
  }
  if (toolOutputCap !== undefined && (!Number.isInteger(toolOutputCap) || toolOutputCap < 0)) {
    throw new VendoError("validation", "toolOutputCap must be a non-negative integer");
  }
}

function validateMessage(message: UIMessage | undefined): asserts message is UIMessage {
  if (!message
    || typeof message.id !== "string"
    || message.id.length === 0
    || !["system", "user", "assistant"].includes(message.role)
    || !Array.isArray(message.parts)) {
    throw new VendoError("validation", "stream requires a valid message");
  }
}

function upsertMessage(messages: UIMessage[], message: UIMessage): void {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) messages.push(message);
  else messages[index] = message;
}

/** 03-agent §1 */
export function createAgent(config: AgentConfig): VendoAgent {
  validateConfig(config);
  const threads = new ThreadRepository(config.store);

  return {
    async stream(input) {
      validateMessage(input?.message);
      const thread = await threads.resolve(input.threadId, input.ctx);
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
          const result = streamText({
            model: config.model,
            system,
            messages: await convertToModelMessages(thread.messages),
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
