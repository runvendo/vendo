import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoUser, getWeather, sendTripReport } from "../lib/vendo";

// Lane E Vendo Cloud e2e, env-gated live (the VENDO_LIVE_MCP pattern):
//
//   VENDO_LIVE_CLOUD=1 VENDO_API_KEY=… pnpm --filter @vendoai-examples/ai-sdk-agent test
//
// This example's composition in FULL Cloud posture — VENDO_API_KEY only, no
// BYO keys: managed inference through the console gateway, cloud sandbox,
// cloud connections, hosted store — driven to an actual app creation. The
// host loop keeps its own (scripted) model: the two-models note — the BYO
// agent's model is the host's business, never part of Vendo's posture.
//
// Also proves the ADAPTER RULE from a BYO-agent loop (reference:
// selectConnections/selectModel in packages/vendo/src/server.ts): the Cloud
// key fills only the seams the host left unset; an explicitly passed adapter
// always wins.

const LIVE = process.env.VENDO_LIVE_CLOUD === "1";
const LIVE_TIMEOUT_MS = 10 * 60 * 1000;

/** Every BYO credential the env ladder or a seam default could pick up: the
 * full-Cloud-posture contract is "VENDO_API_KEY only". */
const BYO_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "E2B_API_KEY",
  "COMPOSIO_API_KEY",
  "VENDO_STORE_ENCRYPTION_KEY",
] as const;

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

const finish = (reason: "stop" | "tool-calls") =>
  ({ type: "finish", usage, finishReason: { unified: reason, raw: undefined } }) as const;

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
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" } as const,
            { type: "text-delta", id: "t1", delta: "Done." } as const,
            { type: "text-end", id: "t1" } as const,
            finish("stop"),
          ],
        }),
      };
    },
  }) as unknown as LanguageModel;
}

const EXPLICIT_MODEL_MARKER = "Explicit adapter wins: this tree came from the host-passed model";

/** An explicit generation model whose output is unmistakably NOT the cloud
 * gateway's — the adapter-rule witness. */
function explicitGenerationModel(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "g1" } as const,
          {
            type: "text-delta",
            id: "g1",
            delta: `<App name="Adapter rule"><Stack><Text text="${EXPLICIT_MODEL_MARKER}"/></Stack></App>`,
          } as const,
          { type: "text-end", id: "g1" } as const,
          finish("stop"),
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

const serverActions = {
  "lib/vendo.ts#getWeather": getWeather,
  "lib/vendo.ts#sendTripReport": sendTripReport,
};

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

const wire = (vendo: Vendo, method: string, path: string) =>
  vendo.handler(new Request(`https://host.test/api/vendo${path}`, { method }));

async function status(vendo: Vendo): Promise<{ blocks: Record<string, unknown> }> {
  const response = await wire(vendo, "GET", "/status");
  expect(response.status).toBe(200);
  return (await response.json()) as { blocks: Record<string, unknown> };
}

/** The app-ref → wire open() resolution the embeds ride; the build streams
 * after the fast ref returns, so 404s are the in-progress signal. */
async function openBuiltApp(vendo: Vendo, appId: string, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let last: Response | undefined;
  while (Date.now() < deadline) {
    last = await wire(vendo, "GET", `/apps/${appId}/open`);
    if (last.status === 200) return last.text();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`app ${appId} never became servable (last status ${last?.status})`);
}

describe.skipIf(!LIVE)("examples/ai-sdk-agent — full Vendo Cloud posture (VENDO_API_KEY only)", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    expect(process.env.VENDO_API_KEY, "VENDO_LIVE_CLOUD=1 needs VENDO_API_KEY").toBeTruthy();
    for (const name of BYO_ENV_KEYS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterAll(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("reports cloud postures on /status and drives a live managed-inference app creation", async () => {
    // The example's composition with every infrastructure seam left unset:
    // VENDO_API_KEY defaults the lot.
    const vendo = createVendo({
      principal: async () => demoUser,
      policy: "cautious",
      serverActions,
    });
    await vendo.store.ensureSchema();
    try {
      const report = await status(vendo);
      expect(report.blocks["sandbox"]).toBe("cloud");
      expect(report.blocks["connections"]).toBe("cloud");
      // The inference seam: no host model ⇒ the composed env ladder, which —
      // with every provider key scrubbed — resolves to the Cloud gateway on
      // first use (the live generation below IS that resolution).
      expect(report.blocks["model"]).toBe("ladder");

      const output = await turn(vendo, "vendo_create_app", {
        prompt: "A dashboard comparing the weather in Paris, London and Tokyo",
      }) as { kind: string; appId: string };
      expect(output.kind).toBe("vendo/app-ref@1");
      expect(output.appId).toMatch(/^app_/);
      // Managed inference generated it; the wire (hosted store underneath)
      // serves the finished surface.
      const surface = await openBuiltApp(vendo, output.appId, 5 * 60_000);
      expect((JSON.parse(surface) as { kind: string }).kind).toBe("tree");
      console.log(`cloud posture app created: ${output.appId}`);
    } finally {
      await vendo.store.close();
    }
  }, LIVE_TIMEOUT_MS);

  it("adapter rule: an explicitly passed adapter beats the Cloud default, seam by seam", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-cloud-adapter-rule-"));
    const store = createStore({ dataDir });
    await store.ensureSchema();
    try {
      // Same env (VENDO_API_KEY set) — but the host passes its own model and
      // its own store. Only the seams left unset stay cloud.
      const vendo = createVendo({
        model: explicitGenerationModel(),
        store,
        principal: async () => demoUser,
        policy: "cautious",
        serverActions,
      });
      const report = await status(vendo);
      expect(report.blocks["model"]).toBe("custom");
      expect(report.blocks["sandbox"]).toBe("cloud");
      expect(report.blocks["connections"]).toBe("cloud");

      // The witness: the app the turn creates was generated by the explicit
      // model, not the gateway — the marker text streams out of the mock.
      const output = await turn(vendo, "vendo_create_app", {
        prompt: "Anything at all",
      }) as { kind: string; appId: string };
      expect(output.kind).toBe("vendo/app-ref@1");
      const surface = await openBuiltApp(vendo, output.appId, 60_000);
      expect(surface).toContain(EXPLICIT_MODEL_MARKER);
    } finally {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, LIVE_TIMEOUT_MS);
});
