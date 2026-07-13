import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type VendoStore } from "@vendoai/store";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel, UIMessage } from "ai";
import { createRelayServer } from "../src/server/index.js";

type ModelPrompt = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];
export type StreamPart = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never;
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
type GenerateContent = GenerateResult["content"][number];

export const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

export function textTurn(text: string, id = "text_1"): StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
}

export function toolCallTurn(toolName: string, input: unknown, toolCallId = "call_1"): StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
  ];
}

export function scriptedModel(turns: StreamPart[][]): LanguageModel {
  const remaining = turns.map((turn) => [...turn]);
  const shift = (_prompt: ModelPrompt): StreamPart[] => {
    const chunks = remaining.shift();
    if (chunks === undefined) throw new Error("scripted model exhausted");
    return chunks;
  };
  return new MockLanguageModelV3({
    doStream: async (request) => ({ stream: simulateReadableStream({ chunks: shift(request.prompt) }) }),
    doGenerate: async (request): Promise<GenerateResult> => {
      const chunks = shift(request.prompt);
      const finish = chunks.find((part) => part.type === "finish");
      const content: GenerateContent[] = [];
      const generatedText = chunks
        .filter((part): part is Extract<StreamPart, { type: "text-delta" }> => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");
      if (generatedText.length > 0) content.push({ type: "text", text: generatedText });
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
  });
}

export interface TestHost {
  baseUrl: string;
  server: Server;
  store: VendoStore;
  tasks: ReturnType<typeof createRelayServer>["tasks"];
  close(): Promise<void>;
}

export async function startTestHost(model: LanguageModel): Promise<TestHost> {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-express-e2e-"));
  const store = createStore({ dataDir });
  const relay = createRelayServer({ model, store });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = relay.app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    store,
    tasks: relay.tasks,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export interface SseRead {
  parts: Array<Record<string, unknown>>;
}

export async function readSse(response: Response): Promise<SseRead> {
  if (!response.ok) throw new Error(`SSE request failed: ${response.status} ${await response.text()}`);
  const raw = await response.text();
  if (!raw.endsWith("\n\n")) throw new Error("SSE response did not end with a blank line");
  return {
    parts: raw.slice(0, -2).split("\n\n")
      .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
      .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>),
  };
}

export function partsOfType(read: SseRead, type: string): Array<Record<string, unknown>> {
  return read.parts.filter((part) => part.type === type);
}

export function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export function respondToApproval(message: UIMessage, toolCallId: string, approved: boolean): UIMessage {
  let updated = false;
  const parts = message.parts.map((part) => {
    const candidate = part as unknown as Record<string, unknown>;
    if (candidate.type !== "dynamic-tool" || candidate.toolCallId !== toolCallId) return part;
    const approval = candidate.approval as { id?: unknown } | undefined;
    if (typeof approval?.id !== "string") throw new Error("tool part carried no native approval id");
    updated = true;
    return {
      ...candidate,
      state: "approval-responded",
      approval: { id: approval.id, approved },
    } as unknown as UIMessage["parts"][number];
  });
  if (!updated) throw new Error(`assistant message carried no dynamic tool part for ${toolCallId}`);
  return { ...message, parts };
}

export function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
