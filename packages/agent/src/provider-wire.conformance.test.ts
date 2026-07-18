import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ToolDescriptor } from "@vendoai/core";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
  type ScriptedModel,
  type TestGuard,
} from "./test-helpers.js";

type Turn =
  | { kind: "tool"; toolName: string; input: unknown; toolCallId: string }
  | { kind: "text"; text: string };

interface TransportHarness {
  model: LanguageModel;
  assertComplete(): void;
  close(): Promise<void>;
}

const turns: Turn[] = [
  { kind: "tool", toolName: "send_echo", input: { value: "hello" }, toolCallId: "call_approval" },
  { kind: "text", text: "Approval handled." },
  { kind: "tool", toolName: "blocked_write", input: { value: "unsafe" }, toolCallId: "call_blocked" },
  { kind: "text", text: "Blocked handled." },
  { kind: "tool", toolName: "vendo_apps_open", input: { appId: "app_1" }, toolCallId: "call_view" },
  { kind: "text", text: "View handled." },
];

const requestBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const responseChunk = (
  turn: Turn,
  index: number,
  finishReason: "stop" | "tool_calls" | null,
): Record<string, unknown> => ({
  id: `chatcmpl-recorded-${index}`,
  object: "chat.completion.chunk",
  created: 1_752_451_200,
  model: "recorded-openai-compatible",
  choices: [{
    index: 0,
    delta: turn.kind === "tool"
      ? {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: turn.toolCallId,
            type: "function",
            function: { name: turn.toolName, arguments: JSON.stringify(turn.input) },
          }],
        }
      : { role: "assistant", content: turn.text },
    finish_reason: finishReason,
  }],
});

async function startOpenAIReplay(script: Turn[]): Promise<TransportHarness> {
  const remaining = [...script];
  const requests: Array<{ url: string; authorization?: string; body: Record<string, unknown> }> = [];
  let responseIndex = 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const body = await requestBody(request);
      requests.push({
        url: request.url ?? "",
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        body,
      });
      const turn = remaining.shift();
      if (turn === undefined) throw new Error("recorded OpenAI response script exhausted");
      responseIndex += 1;
      const finishReason = turn.kind === "tool" ? "tool_calls" : "stop";
      const frames = [
        responseChunk(turn, responseIndex, null),
        {
          id: `chatcmpl-recorded-${responseIndex}`,
          object: "chat.completion.chunk",
          created: 1_752_451_200,
          model: "recorded-openai-compatible",
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake OpenAI endpoint did not bind TCP");
  const provider = createOpenAICompatible({
    name: "recorded-openai-compatible",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "wire-test-key",
  });
  return {
    model: provider("recorded-model") as LanguageModel,
    assertComplete() {
      expect(remaining).toEqual([]);
      expect(requests).toHaveLength(script.length);
      expect(requests.every((request) => request.url === "/v1/chat/completions")).toBe(true);
      expect(requests.every((request) => request.authorization === "Bearer wire-test-key")).toBe(true);
      expect(requests.every((request) => request.body.stream === true)).toBe(true);
      expect(requests.some((request) => Array.isArray(request.body.tools))).toBe(true);
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

function startMock(script: Turn[]): TransportHarness {
  const model: ScriptedModel = scriptedModel(script.map((turn, index) => (
    turn.kind === "tool"
      ? toolCallTurn(turn.toolName, turn.input, turn.toolCallId)
      : textTurn(turn.text, `text_${index}`)
  )));
  return {
    model,
    assertComplete() { expect(model.prompts).toHaveLength(script.length); },
    async close() {},
  };
}

const descriptor = (name: string, risk: "read" | "write"): ToolDescriptor => ({
  name,
  description: `${name} provider-wire fixture`,
  inputSchema: { type: "object" },
  risk,
});

function approvalResponse(message: UIMessage, nativeApprovalId: string): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => part.type === "dynamic-tool" && part.toolCallId === "call_approval"
      ? {
          ...part,
          state: "approval-responded",
          approval: { id: nativeApprovalId, approved: true },
        } as UIMessage["parts"][number]
      : part),
  };
}

function firstPending(guard: TestGuard): string {
  const pending = guard.pending();
  expect(pending).toHaveLength(1);
  return pending[0]!.id;
}

const openHarnesses: TransportHarness[] = [];
afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

for (const transport of [
  { name: "ai-SDK MockLanguageModelV3", start: async () => startMock(turns) },
  { name: "recorded OpenAI-compatible SSE", start: async () => startOpenAIReplay(turns) },
]) {
  describe(`03-agent §§2–4 provider wire conformance — ${transport.name}`, () => {
    it("runs approval pause/resume, blocked outcome, and view-part journeys", async () => {
      const harness = await transport.start();
      openHarnesses.push(harness);
      const guard = testGuard({ send_echo: "ask", blocked_write: "block", vendo_apps_open: "run" });
      const tools = boundRegistry({
        send_echo: {
          descriptor: descriptor("send_echo", "write"),
          execute: async (input) => ({ echoed: (input as { value: string }).value }),
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
              nodes: [{ id: "r", component: "Text", props: { text: "Ready" } }],
            },
          }),
        },
      }, guard);
      const agent = createAgent({ model: harness.model, tools, guard });
      const runCtx = ctx();

      const paused = await readSse(await agent.stream({
        threadId: "thr_provider_wire",
        message: userMessage("user_approval", "Call send_echo"),
        ctx: runCtx,
      }));
      const nativeApproval = paused.parts.find((part) => part.type === "tool-approval-request");
      expect(nativeApproval, JSON.stringify(paused.parts)).toBeDefined();
      expect(typeof nativeApproval?.approvalId).toBe("string");
      expect(paused.parts.find((part) => part.type === "data-vendo-approval")).toMatchObject({
        data: { toolCallId: "call_approval", risk: "write" },
      });
      const coreApprovalId = firstPending(guard);
      const thread = await agent.threads.get("thr_provider_wire", runCtx);
      const assistant = thread?.messages.find((message) => message.role === "assistant");
      expect(assistant).toBeDefined();

      guard.decide(coreApprovalId, true);
      const resumed = await readSse(await agent.stream({
        threadId: "thr_provider_wire",
        message: approvalResponse(assistant!, String(nativeApproval?.approvalId)),
        ctx: runCtx,
      }));
      expect(resumed.parts.find((part) => part.type === "tool-output-available")).toMatchObject({
        toolCallId: "call_approval",
        output: { status: "ok", output: { echoed: "hello" } },
      });
      expect(tools.invocations.send_echo).toBe(1);

      const blocked = await readSse(await agent.stream({
        threadId: "thr_provider_wire",
        message: userMessage("user_blocked", "Call blocked_write"),
        ctx: runCtx,
      }));
      expect(blocked.parts.find((part) => part.type === "tool-output-available")).toMatchObject({
        toolCallId: "call_blocked",
        output: { status: "blocked", reason: "blocked" },
      });
      expect(tools.invocations.blocked_write).toBe(0);

      const view = await readSse(await agent.stream({
        threadId: "thr_provider_wire",
        message: userMessage("user_view", "Call vendo_apps_open"),
        ctx: runCtx,
      }));
      expect(view.parts.find((part) => part.type === "data-vendo-view")).toMatchObject({
        data: { appId: "app_1", payload: { formatVersion: "vendo-genui/v2", root: "r" } },
      });
      expect(tools.invocations.vendo_apps_open).toBe(1);
      harness.assertComplete();
    }, 30_000);
  });
}
