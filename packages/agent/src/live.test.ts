import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import type { ToolDescriptor } from "@vendoai/core";
import type { LanguageModel, UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  readSse,
  testGuard,
  userMessage,
  type TestGuard,
} from "./test-helpers.js";

interface LiveProvider {
  name: string;
  enabled: boolean;
  model(): LanguageModel;
}

const descriptor = (name: string, risk: "read" | "write"): ToolDescriptor => ({
  name,
  description: `${name} live provider-matrix fixture`,
  inputSchema: { type: "object" },
  risk,
});

function firstPending(guard: TestGuard): string {
  const pending = guard.pending();
  expect(pending).toHaveLength(1);
  return pending[0]!.id;
}

function approvalResponse(message: UIMessage, nativeApprovalId: string): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => part.type === "dynamic-tool" && part.toolCallId !== undefined
      ? {
          ...part,
          state: "approval-responded",
          approval: { id: nativeApprovalId, approved: true },
        } as UIMessage["parts"][number]
      : part),
  };
}

async function runProviderJourney(model: LanguageModel): Promise<void> {
  const guard = testGuard({ send_echo: "ask", blocked_write: "block", vendo_apps_open: "run" });
  const tools = boundRegistry({
    send_echo: {
      descriptor: descriptor("send_echo", "write"),
      execute: async (input) => ({ echoed: (input as { value?: string }).value ?? "live" }),
    },
    blocked_write: {
      descriptor: descriptor("blocked_write", "write"),
      execute: async () => ({ shouldNotRun: true }),
    },
    vendo_apps_open: {
      descriptor: descriptor("vendo_apps_open", "read"),
      execute: async () => ({
        kind: "tree",
        payload: {
          formatVersion: "vendo-genui/v2",
          root: "r",
          nodes: [{ id: "r", component: "Text", props: { text: "Live provider" } }],
        },
      }),
    },
  }, guard);
  const agent = createAgent({
    model,
    tools,
    guard,
    system: {
      instructions: [
        "This is a deterministic conformance journey.",
        "For a message beginning APPROVAL, call send_echo exactly once with {\"value\":\"live\"}.",
        "For a message beginning BLOCKED, call blocked_write exactly once with {\"value\":\"unsafe\"}.",
        "For a message beginning VIEW, call vendo_apps_open exactly once with {\"appId\":\"app_1\"}.",
        "After each tool result, answer briefly in text and do not call another tool.",
      ].join(" "),
    },
  });
  const runCtx = ctx();
  const threadId = "thr_live_provider_matrix";

  const paused = await readSse(await agent.stream({
    threadId,
    message: userMessage("user_live_approval", "APPROVAL: run the required tool now."),
    ctx: runCtx,
  }));
  const nativeApproval = paused.parts.find((part) => part.type === "tool-approval-request");
  expect(typeof nativeApproval?.approvalId).toBe("string");
  expect(paused.parts.some((part) => part.type === "data-vendo-approval")).toBe(true);
  const coreApprovalId = firstPending(guard);
  const thread = await agent.threads.get(threadId, runCtx);
  const assistant = thread?.messages.find((message) => message.role === "assistant");
  expect(assistant).toBeDefined();

  guard.decide(coreApprovalId, true);
  const resumed = await readSse(await agent.stream({
    threadId,
    message: approvalResponse(assistant!, String(nativeApproval?.approvalId)),
    ctx: runCtx,
  }));
  expect(resumed.parts.find((part) => part.type === "tool-output-available")).toMatchObject({
    output: { status: "ok" },
  });
  expect(tools.invocations.send_echo).toBe(1);

  const blocked = await readSse(await agent.stream({
    threadId,
    message: userMessage("user_live_blocked", "BLOCKED: run the required tool now."),
    ctx: runCtx,
  }));
  expect(blocked.parts.find((part) => part.type === "tool-output-available")).toMatchObject({
    output: { status: "blocked", reason: "blocked" },
  });
  expect(tools.invocations.blocked_write).toBe(0);

  const view = await readSse(await agent.stream({
    threadId,
    message: userMessage("user_live_view", "VIEW: run the required tool now."),
    ctx: runCtx,
  }));
  expect(view.parts.find((part) => part.type === "data-vendo-view")).toMatchObject({
    data: { appId: "app_1", payload: { formatVersion: "vendo-genui/v2" } },
  });
  expect(tools.invocations.vendo_apps_open).toBe(1);
}

const liveProviders: LiveProvider[] = [
  {
    name: "Anthropic",
    enabled: Boolean(process.env.ANTHROPIC_API_KEY),
    model: () => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(
      process.env.ANTHROPIC_TEST_MODEL ?? "claude-haiku-4-5-20251001",
    ),
  },
  {
    name: "OpenAI",
    enabled: Boolean(process.env.OPENAI_API_KEY),
    model: () => createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(
      process.env.OPENAI_TEST_MODEL ?? "gpt-4.1-mini",
    ),
  },
  {
    name: "OpenAI-compatible proxy",
    enabled: Boolean(process.env.VENDO_TEST_PROXY_URL && process.env.VENDO_TEST_PROXY_KEY),
    model: () => createOpenAICompatible({
      name: "vendo-test-proxy",
      baseURL: process.env.VENDO_TEST_PROXY_URL!,
      apiKey: process.env.VENDO_TEST_PROXY_KEY,
    })(process.env.VENDO_TEST_PROXY_MODEL ?? "gpt-4.1-mini"),
  },
];

for (const provider of liveProviders) {
  describe.skipIf(!provider.enabled)(`03-agent provider matrix live — ${provider.name}`, () => {
    it("runs the shared approval, blocked-outcome, and view-part journey", async () => {
      await runProviderJourney(provider.model());
    }, 180_000);
  });
}
