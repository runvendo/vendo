/**
 * Wave-1 live proof P1 — which thinker actually ran, and what it was told.
 *
 * `POST /threads` is `deps.harness ?? deps.agent` (wire/threads.ts). This probe
 * pins all three reachable combinations by recording the SYSTEM PROMPT the model
 * receives, through the real `createVendo` composition:
 *
 *   1. no `harness:`  + POST /threads              → legacy `createAgent`
 *   2. `harness: vendo()` + POST /threads          → harness runtime
 *   3. no `harness:`  + vendo.harness.stream()     → harness runtime, composed
 *
 * The system prompt is the discriminator because it is assembled by composition
 * (`assembleSystemPrompt`) and handed to `vendo()` only in case 3 — see
 * `resolveHarness` in harness-turn.ts. A recording model makes the difference a
 * fact rather than a reading of the code.
 *
 * Run: node packages/vendo/proofs/p1-harness-path.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVendo } from "@vendoai/vendo/server";
import { createStore } from "@vendoai/store";
import { vendo as vendoHarness } from "@vendoai/harnesses";

const principal = { kind: "user", subject: "user_probe" };

/** Records every system prompt it is asked to think with, then says one line. */
function recordingModel(seen) {
  return {
    specificationVersion: "v2",
    provider: "probe",
    modelId: "probe-v1",
    supportedUrls: {},
    async doStream(call) {
      const system = call.prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      seen.push(system);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

const hostTool = {
  async descriptors() {
    return [{
      name: "maple_listAccounts",
      title: "List accounts",
      description: "List the signed-in customer's accounts",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    }];
  },
  async execute() {
    return { status: "ok", output: { accounts: [] } };
  },
};

async function compose(overrides) {
  const dataDir = await mkdtemp(join(tmpdir(), "p1-harness-"));
  const store = createStore({ dataDir });
  const seen = [];
  const vendo = createVendo({
    models: { default: recordingModel(seen) },
    principal: async () => principal,
    store,
    agent: { instructions: "PROBE-VOICE: speak like Maple." },
    ...overrides,
  });
  vendo.actions.add(hostTool);
  return {
    vendo,
    seen,
    async close() {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const message = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] });

const post = (vendo, body) =>
  vendo.handler(new Request("https://probe.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const ctx = () => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "sess_probe",
});

const results = {};

// 1. No harness named — POST /threads must stay on the legacy agent.
{
  const c = await compose({});
  const res = await post(c.vendo, { threadId: "thr_1", message: message("m1", "hello") });
  await res.text();
  results.legacyWire = c.seen[0] ?? "";
  await c.close();
}

// 2. `harness: vendo()` — the literal contract opt-in.
{
  const c = await compose({ harness: vendoHarness() });
  const res = await post(c.vendo, { threadId: "thr_2", message: message("m2", "hello") });
  await res.text();
  results.namedHarnessWire = c.seen[0] ?? "";
  await c.close();
}

// 3. No harness named, driven through the composed `vendo.harness` door.
{
  const c = await compose({});
  const res = await c.vendo.harness.stream({ threadId: "thr_3", message: message("m3", "hello"), ctx: ctx() });
  await res.text();
  results.composedHarnessDoor = c.seen[0] ?? "";
  await c.close();
}

const report = Object.fromEntries(
  Object.entries(results).map(([k, v]) => [k, {
    systemPromptChars: v.length,
    hasHostVoice: v.includes("PROBE-VOICE"),
    hasGuardDirections: /guard|approval|permission/i.test(v),
    hasFindTools: v.includes("find_tools"),
    firstLine: v.split("\n")[0]?.slice(0, 90) ?? "",
  }]),
);
console.log(JSON.stringify(report, null, 2));
