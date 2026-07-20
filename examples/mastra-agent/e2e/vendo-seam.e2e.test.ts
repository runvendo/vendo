// Fixture e2e for the Mastra example — one real turn per Vendo value prop,
// hermetic (scripted models, temp PGlite store, no network, no keys):
//
//   1. Guarded tools in the Mastra loop: a real Agent turn calls
//      vendo_send_trip_report; the ask-policy call parks server-side and the
//      loop receives the vendo/approval-ref@1 envelope without blocking.
//      Approving over the wire executes the parked call; GET /approvals/:id
//      serves the "executed" state the embed renders.
//   2. Generated UI: vendo_create_app returns the vendo/app-ref@1 envelope.
//   3. Delegation: vendo_delegate runs Vendo's own loop and reports back.
//
// It exercises the example's REAL wiring: composeVendo (policy, serverActions),
// the checked-in .vendo/tools.json, and the same tools spread the starter
// agent uses — only the model is scripted and the store is a temp dir.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";
import { parseVendoToolEnvelope, vendoAppRefSchema, vendoApprovalRefSchema } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { VENDO_PRINCIPAL_KEY, VENDO_SESSION_KEY, vendoMastraTools } from "@vendoai/vendo/mastra";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";
import { DEMO_PRINCIPAL, composeVendo } from "../src/lib/vendo";
import { sentTripReports } from "../src/lib/vendo-actions";
import { weatherTool } from "../src/mastra/tools/weather-tool";

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

type StreamPart = Record<string, unknown>;

const textTurn = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
];

// Mastra's loop accumulates tool calls from the input-streaming bracket, so a
// scripted tool call must stream tool-input-start/delta/end before tool-call.
const toolCallTurn = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call_1", toolName },
  { type: "tool-input-delta", id: "call_1", delta: JSON.stringify(input) },
  { type: "tool-input-end", id: "call_1" },
  { type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
];

/** A deterministic LanguageModel: answers each call from `respond`, recording
 *  every prompt so tests can assert what the model actually saw. */
function scripted(respond: (promptText: string) => StreamPart[]): {
  model: LanguageModel;
  prompts: string[];
} {
  const prompts: string[] = [];
  const chunksFor = (prompt: unknown): StreamPart[] => {
    const text = JSON.stringify(prompt);
    prompts.push(text);
    return respond(text);
  };
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => ({
      stream: simulateReadableStream({ chunks: chunksFor(prompt) as never }),
    }),
    doGenerate: async ({ prompt }) => {
      const chunks = chunksFor(prompt);
      const text = chunks
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta as string)
        .join("");
      const content: unknown[] = text.length > 0 ? [{ type: "text", text }] : [];
      for (const part of chunks) {
        if (part.type === "tool-call") content.push(part);
      }
      const finish = chunks.find((part) => part.type === "finish");
      return {
        content,
        finishReason: (finish?.finishReason ?? { unified: "stop", raw: undefined }),
        usage: ZERO_USAGE,
        warnings: [],
      } as never;
    },
  });
  return { model: model as unknown as LanguageModel, prompts };
}

const wireRequest = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const executionContext = (): { requestContext: RequestContext; observe: typeof noopObserve } => {
  const requestContext = new RequestContext();
  requestContext.set(VENDO_PRINCIPAL_KEY, DEMO_PRINCIPAL);
  requestContext.set(VENDO_SESSION_KEY, "session_fixture");
  return { requestContext, observe: noopObserve };
};

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DELEGATE_MARKER = "Compile a weather brief for the ops team";
const APP_MARKUP = '<App name="Weather comparison"><Text text="Paris vs Tokyo vs NYC"/></App>';

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "mastra-example-store-"));
  // Vendo's own model (app generation, the delegate loop) — distinct from the
  // Mastra agent's model, exactly like the example (two models, deliberately).
  const vendoModel = scripted((prompt) =>
    prompt.includes(DELEGATE_MARKER) ? textTurn("Weather brief compiled.") : [
      { type: "text-start", id: "g1" },
      { type: "text-delta", id: "g1", delta: APP_MARKUP },
      { type: "text-end", id: "g1" },
      { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
    ],
  );
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const vendo = composeVendo({ model: vendoModel.model, store });
  await vendo.store.ensureSchema();
  return { vendo };
}

describe.sequential("mastra-agent example — the Vendo seam end to end", () => {
  it("parks a risky action from a real Mastra turn, approves over the wire, and executes it", async () => {
    const { vendo } = await setup();
    const sentBefore = sentTripReports.length;

    // The example agent's shape (weatherTool + the Vendo pack), with a
    // scripted model in place of the starter's OpenAI pin.
    const agentModel = scripted((prompt) =>
      prompt.includes("vendo/approval-ref@1")
        ? textTurn("The report is waiting for your approval in the chat.")
        : toolCallTurn("vendo_send_trip_report", { recipient: "ops@example.com", report: "Sunny in Paris" }),
    );
    const agent = new Agent({
      id: "weather-agent-fixture",
      name: "Weather Agent (fixture)",
      instructions: "Use vendo_send_trip_report to email reports.",
      model: agentModel.model as never,
      tools: async () => ({ weatherTool, ...(await vendoMastraTools(vendo)) }),
    });

    const requestContext = executionContext().requestContext;
    const result = await agent.generate("Email my Paris report to ops@example.com", { requestContext });

    // The loop got the envelope (no throw, no block) and answered around it.
    expect(agentModel.prompts.length).toBe(2);
    expect(agentModel.prompts[1]).toContain("vendo/approval-ref@1");
    expect(result.text).toContain("approval");

    // Parked server-side under the caller's principal; nothing executed yet.
    const pending = await vendo.guard.approvals.pending(DEMO_PRINCIPAL);
    expect(pending).toHaveLength(1);
    expect(sentTripReports.length).toBe(sentBefore);
    const approvalId = pending[0]!.id;

    // The embed's read: pending now …
    const before = await vendo.handler(wireRequest("GET", `/approvals/${approvalId}`));
    expect(before.status).toBe(200);
    expect(((await before.json()) as { state: string }).state).toBe("pending");

    // … approve over the wire → the parked call executes the real handler.
    const decide = await vendo.handler(
      wireRequest("POST", "/approvals/decide", { ids: [approvalId], decision: { approve: true } }),
    );
    expect(decide.status).toBe(200);
    expect(sentTripReports.length).toBe(sentBefore + 1);
    expect(sentTripReports.at(-1)).toMatchObject({ recipient: "ops@example.com" });

    const after = await vendo.handler(wireRequest("GET", `/approvals/${approvalId}`));
    expect(((await after.json()) as { state: string }).state).toBe("executed");
  });

  it("vendo_create_app returns the vendo/app-ref@1 envelope from a real generation", async () => {
    const { vendo } = await setup();
    const tools = await vendoMastraTools(vendo);
    const output = await tools["vendo_create_app"]!.execute!(
      { prompt: "Compare weather in Paris, Tokyo and NYC" },
      executionContext(),
    );
    const ref = vendoAppRefSchema.parse(output);
    expect(ref.appId).toMatch(/^app_/);
    expect(ref.title.length).toBeGreaterThan(0);
  });

  it("vendo_delegate runs Vendo's own loop and returns a plain-data report", async () => {
    const { vendo } = await setup();
    const tools = await vendoMastraTools(vendo);
    const output = await tools["vendo_delegate"]!.execute!(
      { task: DELEGATE_MARKER },
      executionContext(),
    );
    expect(parseVendoToolEnvelope(output)).toBeNull();
    expect(output).toMatchObject({ status: "ok" });
    expect((output as { summary: string }).summary.length).toBeGreaterThan(0);
  });

  it("a turn without the principal in the request context fails closed", async () => {
    const { vendo } = await setup();
    const tools = await vendoMastraTools(vendo);
    await expect(
      tools["vendo_send_trip_report"]!.execute!(
        { recipient: "ops@example.com", report: "x" },
        { requestContext: new RequestContext(), observe: noopObserve },
      ),
    ).rejects.toThrowError(new RegExp(VENDO_PRINCIPAL_KEY));
  });

  it("the approval envelope parses with the shared schema (what <VendoToolResult> dispatches on)", async () => {
    const { vendo } = await setup();
    const tools = await vendoMastraTools(vendo);
    const output = await tools["vendo_send_trip_report"]!.execute!(
      { recipient: "ops@example.com", report: "Windy in Tokyo" },
      executionContext(),
    );
    const envelope = vendoApprovalRefSchema.parse(output);
    expect(envelope.approvalId).toMatch(/^apr_/);
    expect(envelope.summary.length).toBeGreaterThan(0);
  });
});
