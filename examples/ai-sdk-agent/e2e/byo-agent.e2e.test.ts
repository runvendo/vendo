import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVendoToolEnvelope,
  vendoAppRefSchema,
  vendoApprovalRefSchema,
} from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { vendoTools } from "@vendoai/vendo/ai-sdk";
import { createVendo, type Vendo } from "@vendoai/vendo/server";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { demoUser, getWeather, sendTripReport, sentReports } from "../lib/vendo";

// Fixture e2e (the fixtures/mcp-e2e precedent): one REAL AI SDK turn per value
// prop, driving the exact seam app/api/chat/route.ts uses — `streamText` with
// the `vendoTools` pack over a real `createVendo` composition (real store, real
// guard, this example's own `.vendo/tools.json` + serverActions map) — then
// resolving the result over the real wire the embeds talk to. Hermetic: both
// models (the "existing agent" loop and Vendo's generation seam) are scripted.

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

const finish = (reason: "stop" | "tool-calls") =>
  ({ type: "finish", usage, finishReason: { unified: reason, raw: undefined } }) as const;

const textChunks = (text: string) => [
  { type: "text-start", id: "t1" } as const,
  { type: "text-delta", id: "t1", delta: text } as const,
  { type: "text-end", id: "t1" } as const,
  finish("stop"),
];

/** The "existing agent": first step calls one tool, second step wraps up. */
function hostAgentModel(toolName: string, input: unknown): LanguageModel {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      step += 1;
      if (step === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: `call_${toolName}`, toolName, input: JSON.stringify(input) },
              finish("tool-calls"),
            ],
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: textChunks("Done.") }) };
    },
  }) as unknown as LanguageModel;
}

/** Vendo's own model seam: answers `vendo_create_app` generation requests with
 *  a minimal valid tree so the build streams for real. */
function generationModel(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const serialized = JSON.stringify(prompt);
      if (serialized.includes("TASK: CREATE_APP")) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "g1" } as const,
              {
                type: "text-delta",
                id: "g1",
                delta: '<App name="Weather dashboard"><Stack><Text text="Paris, London, and Tokyo at a glance"/></Stack></App>',
              } as const,
              { type: "text-end", id: "g1" } as const,
              finish("stop"),
            ],
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: textChunks("ok") }) };
    },
  }) as unknown as LanguageModel;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  sentReports.splice(0);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function compose(): Promise<Vendo> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-ai-sdk-example-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  // The example's exact composition (lib/vendo.ts) with the model seam and
  // store swapped for hermetic test doubles. Vitest runs from the example
  // root, so `.vendo/tools.json` — the same manifest production reads — is
  // what declares the two host actions.
  return createVendo({
    model: generationModel(),
    principal: async () => demoUser,
    policy: "cautious",
    store,
    serverActions: {
      "lib/vendo.ts#getWeather": getWeather,
      "lib/vendo.ts#sendTripReport": sendTripReport,
    },
  });
}

/** One real AI SDK turn, exactly as app/api/chat/route.ts runs it. */
async function turn(vendo: Vendo, toolName: string, input: unknown): Promise<unknown> {
  const messages: UIMessage[] = [
    { id: "m1", role: "user", parts: [{ type: "text", text: `use ${toolName}` }] },
  ];
  const result = streamText({
    model: hostAgentModel(toolName, input),
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(5),
    tools: { ...(await vendoTools(vendo, { principal: demoUser })) },
  });
  await result.consumeStream();
  const steps = await result.steps;
  const toolResult = steps
    .flatMap((step) => step.toolResults)
    .find((entry) => entry.toolName === toolName);
  expect(toolResult, `expected a ${toolName} tool result`).toBeDefined();
  return toolResult!.output;
}

const wire = (vendo: Vendo, method: string, path: string, body?: unknown) =>
  vendo.handler(
    new Request(`https://host.test/api/vendo${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );

describe.sequential("examples/ai-sdk-agent — one real turn per value prop", () => {
  it("guarded action: the weather lookup executes through the guard and returns plain data", async () => {
    const vendo = await compose();
    const output = await turn(vendo, "vendo_host_get_weather", { city: "Paris" });
    // Plain data — no envelope: the action ran cleanly through policy → audit.
    expect(parseVendoToolEnvelope(output)).toBeNull();
    expect(output).toMatchObject({ city: "Paris" });
    expect(output).toHaveProperty("temperature");
  });

  it("generated UI: vendo_create_app returns the app-ref envelope fast and the wire serves the built app", async () => {
    const vendo = await compose();
    const output = await turn(vendo, "vendo_create_app", {
      prompt: "A dashboard comparing weather in Paris, London and Tokyo",
    });
    const envelope = vendoAppRefSchema.parse(output);
    expect(envelope.kind).toBe("vendo/app-ref@1");
    expect(envelope.appId).toMatch(/^app_/);
    expect(envelope.title.length).toBeGreaterThan(0);
    // The embed's resolution path: the build streams over the wire; open()
    // serves the finished surface. Poll briefly — the ref returns before the
    // build settles by design.
    let opened: Response | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      opened = await wire(vendo, "GET", `/apps/${envelope.appId}/open`);
      if (opened.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(opened!.status).toBe(200);
    const surface = (await opened!.json()) as { kind: string };
    expect(surface.kind).toBe("tree");
    expect(JSON.stringify(surface)).toContain("Paris, London, and Tokyo at a glance");
  });

  it("approvals: the risky action parks, the wire approves, and the parked call executes", async () => {
    const vendo = await compose();
    const report = { to: "boss@example.com", subject: "Trip report", body: "Warm everywhere." };
    const output = await turn(vendo, "vendo_host_send_trip_report", report);
    const envelope = vendoApprovalRefSchema.parse(output);
    expect(envelope.kind).toBe("vendo/approval-ref@1");
    // Parked, not executed: the loop got its envelope, nothing was sent.
    expect(sentReports).toHaveLength(0);
    const pendingRead = await wire(vendo, "GET", `/approvals/${envelope.approvalId}`);
    expect(pendingRead.status).toBe(200);
    expect(await pendingRead.json()).toMatchObject({ state: "pending" });
    // Approve over the SAME wire <VendoApprovalEmbed> uses…
    const decided = await wire(vendo, "POST", "/approvals/decide", {
      ids: [envelope.approvalId],
      decision: { approve: true },
    });
    expect(decided.status).toBe(200);
    // …and the parked call lands its effect.
    expect(sentReports).toEqual([report]);
    const executedRead = await wire(vendo, "GET", `/approvals/${envelope.approvalId}`);
    expect(await executedRead.json()).toMatchObject({
      state: "executed",
      outcome: { status: "ok", output: { delivered: true, to: report.to, subject: report.subject } },
    });
  });
});
