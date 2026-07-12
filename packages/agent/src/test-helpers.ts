import type {
  ApprovalId,
  ApprovalRequest,
  AuditEvent,
  Guard,
  GuardDecision,
  Json,
  RunContext,
  ToolCall,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
} from "@vendoai/core";
import type { UIMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { expect } from "vitest";

type LanguageModelV3Prompt = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];
type LanguageModelV3StreamPart = Awaited<
  ReturnType<MockLanguageModelV3["doStream"]>
>["stream"] extends ReadableStream<infer Part> ? Part : never;
type LanguageModelV3GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
type LanguageModelV3Content = LanguageModelV3GenerateResult["content"][number];

export const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

export function textTurn(text: string, id = "text_1"): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
}

export function toolCallTurn(
  toolName: string,
  input: unknown,
  toolCallId = "call_1",
): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
  ];
}

export type ScriptedModel = MockLanguageModelV3 & {
  prompts: LanguageModelV3Prompt[];
};

export function scriptedModel(turns: LanguageModelV3StreamPart[][]): ScriptedModel {
  const remaining = turns.map((turn) => [...turn]);
  const prompts: LanguageModelV3Prompt[] = [];
  const shift = (prompt: LanguageModelV3Prompt): LanguageModelV3StreamPart[] => {
    prompts.push(structuredClone(prompt));
    const chunks = remaining.shift();
    if (chunks === undefined) throw new Error("scripted model exhausted");
    return chunks;
  };
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const chunks = shift(request.prompt);
      return { stream: simulateReadableStream({ chunks }) };
    },
    doGenerate: async (request): Promise<LanguageModelV3GenerateResult> => {
      const chunks = shift(request.prompt);
      const finish = chunks.find((part) => part.type === "finish");
      const content: LanguageModelV3Content[] = [];
      const text = chunks
        .filter((part): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");
      if (text.length > 0) content.push({ type: "text", text });
      for (const part of chunks) {
        if (part.type === "tool-call") content.push(structuredClone(part));
      }
      return {
        content,
        finishReason: finish?.finishReason ?? { unified: "stop", raw: undefined },
        usage: finish?.usage ?? ZERO_USAGE,
        warnings: [],
      };
    },
  }) as ScriptedModel;
  model.prompts = prompts;
  return model;
}

export type TestGuard = Guard & {
  events: AuditEvent[];
  directionValues: string[];
  decide(approvalId: ApprovalId, approved: boolean): void;
  pending(): ApprovalRequest[];
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function testGuard(
  policy: Record<string, "run" | "ask" | "block">,
  directions: string[] = [],
): TestGuard {
  const approvalsByCall = new Map<string, ApprovalRequest>();
  const decisions = new Map<ApprovalId, boolean>();
  const subscribers = new Set<(id: ApprovalId, approved: boolean) => void>();
  const events: AuditEvent[] = [];
  const directionValues = [...directions];

  const guard: TestGuard = {
    events,
    directionValues,
    async check(call, descriptor, runCtx): Promise<GuardDecision> {
      const action = policy[call.tool] ?? "run";
      if (action === "run") return { action: "run", decidedBy: "default" };
      if (action === "block") return { action: "block", reason: "blocked", decidedBy: "rule" };

      let approval = approvalsByCall.get(call.id);
      if (approval === undefined) {
        approval = {
          id: `apr_${call.id}`,
          call: structuredClone(call),
          descriptor: deepFreeze(structuredClone(descriptor)),
          inputPreview: JSON.stringify(call.args),
          ctx: {
            principal: structuredClone(runCtx.principal),
            venue: runCtx.venue,
            presence: runCtx.presence,
            ...(runCtx.appId === undefined ? {} : { appId: runCtx.appId }),
            ...(runCtx.trigger === undefined ? {} : { trigger: structuredClone(runCtx.trigger) }),
          },
          createdAt: new Date().toISOString(),
        };
        approvalsByCall.set(call.id, approval);
      }

      const approved = decisions.get(approval.id);
      if (approved === true) return { action: "run", decidedBy: "default" };
      if (approved === false) return { action: "block", reason: "denied", decidedBy: "rule" };
      return { action: "ask", approval, decidedBy: "rule" };
    },
    async report(event) {
      events.push(structuredClone(event));
    },
    async directions() {
      return [...directionValues];
    },
    onApprovalDecision(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    decide(approvalId, approved) {
      decisions.set(approvalId, approved);
      for (const subscriber of subscribers) subscriber(approvalId, approved);
    },
    pending() {
      return [...approvalsByCall.values()].filter((approval) => !decisions.has(approval.id));
    },
  };

  return guard;
}

export interface TestToolImplementation {
  descriptor: ToolDescriptor;
  execute(args: Json, ctx: RunContext, call: ToolCall): Json | Promise<Json>;
}

export type BoundRegistry = ToolRegistry & {
  invocations: Record<string, number>;
};

export function boundRegistry(
  implementations: Record<string, TestToolImplementation>,
  guard: Guard,
): BoundRegistry {
  const invocations = Object.fromEntries(
    Object.keys(implementations).map((name) => [name, 0]),
  ) as Record<string, number>;

  return {
    invocations,
    async descriptors() {
      return Object.values(implementations).map(({ descriptor }) => structuredClone(descriptor));
    },
    async execute(call, runCtx) {
      const implementation = implementations[call.tool];
      if (implementation === undefined) {
        return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
      }

      const decision = await guard.check(call, implementation.descriptor, runCtx);
      let outcome: ToolOutcome;
      if (decision.action === "block") {
        outcome = { status: "blocked", reason: decision.reason };
      } else if (decision.action === "ask") {
        outcome = { status: "pending-approval", approvalId: decision.approval.id };
      } else {
        invocations[call.tool] = (invocations[call.tool] ?? 0) + 1;
        try {
          outcome = { status: "ok", output: await implementation.execute(call.args, runCtx, call) };
        } catch (error) {
          outcome = {
            status: "error",
            error: {
              code: "execution",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }

      await guard.report({
        id: `aud_${call.id}`,
        at: new Date().toISOString(),
        kind: "tool-call",
        principal: structuredClone(runCtx.principal),
        venue: runCtx.venue,
        presence: runCtx.presence,
        ...(runCtx.appId === undefined ? {} : { appId: runCtx.appId }),
        ...(runCtx.trigger === undefined ? {} : { trigger: structuredClone(runCtx.trigger) }),
        tool: call.tool,
        inputPreview: JSON.stringify(call.args),
        outcome: outcome.status,
        decidedBy: decision.decidedBy,
      });
      return outcome;
    },
  };
}

// The core conformance kit ships the reference in-memory StoreAdapter; tests
// exercise the same double every other block will use.
export { memoryStoreAdapter as memoryStore } from "@vendoai/core/conformance";

export async function readSse(response: Response): Promise<{
  rawFrames: string[];
  parts: Array<Record<string, unknown>>;
}> {
  const raw = await response.text();
  expect(raw.endsWith("\n\n")).toBe(true);
  const blocks = raw.slice(0, -2).split("\n\n");
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.every((block) => block.startsWith("data: ") && !block.includes("\n"))).toBe(true);
  const rawFrames = blocks.map((block) => `${block}\n\n`);
  expect(rawFrames.at(-1)).toBe("data: [DONE]\n\n");
  const parts = blocks.slice(0, -1).map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  return { rawFrames, parts };
}

export function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    principal: { kind: "user", subject: "u1" },
    venue: "chat",
    presence: "present",
    sessionId: "s1",
    ...overrides,
  };
}

/** A minimal single-text-part user UIMessage — the shape every suite feeds stream(). */
export function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/** The first assembled UIMessage part of a given type (e.g. "data-vendo-view"). */
export function partOfType(message: UIMessage, type: string): Record<string, unknown> | undefined {
  return message.parts.find((part) => part.type === type) as Record<string, unknown> | undefined;
}
