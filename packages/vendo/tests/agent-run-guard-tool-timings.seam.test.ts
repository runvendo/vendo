/**
 * `agent_run`'s GUARD and TOOL phases, end to end.
 *
 * The sibling seam test proves the turn-setup marks; these two were shipped at
 * zero because the guard and the tool bridge sit under a different slice than
 * the collector. Same seam discipline as that test: ONE real composed turn
 * through `createVendo`, a REAL guard whose judge is the slow decider (which is
 * what a judge is in production — a model call), a real host tool that takes
 * real time, the SHIPPED `createSdkEvents` pipeline as the sink, and every
 * assertion read off the POSTed body. Only the network is stood in for.
 *
 * Both tools are called TWICE, and the floors are two sleeps' worth, because
 * `guardMs`/`toolsMs` are sums over a turn's calls — a mark that recorded only
 * the last call would pass a one-call test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, ToolDescriptor, ToolRegistry, VendoUsageEvent } from "@vendoai/core";
import { setUsageSink } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, expect, it } from "vitest";
import { createSdkEvents } from "../src/sdk-events.js";
import { createVendo, guard } from "../src/server.js";

type AgentRun = Extract<VendoUsageEvent, { name: "agent_run" }>;

/** What the judge takes to decide, and what the host's tool takes to run. The
 *  turn makes two calls, so each phase's floor below is twice this. */
const PHASE_MS = 30;
const CALLS = 2;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setUsageSink(undefined);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const descriptor = (name: string): ToolDescriptor => ({
  name,
  title: name,
  description: `The host's ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
});

const hostTools: ToolRegistry = {
  async descriptors() {
    return [descriptor("maple_invoices_list")];
  },
  async execute() {
    await sleep(PHASE_MS);
    return { status: "ok", output: { invoices: [] } };
  },
};

it("reports the guard's decision time and the tools' run time, summed over the turn's calls", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-guard-tool-timings-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const vendo = createVendo({
    // Never reached: the harness below is scripted, so no provider is involved.
    models: { default: {} as LanguageModel },
    principal: async (): Promise<Principal> => ({ kind: "user", subject: "user_phases" }),
    store,
    // The real guard. Its judge is the slow decider — no rule matches, so every
    // call goes the whole pipeline and ends here, which is the evaluation
    // `guardMs` is supposed to be measuring.
    guard: guard({
      judge: {
        async decide() {
          await sleep(PHASE_MS);
          return { action: "run", rationale: "reads are fine" };
        },
      },
    }),
    harness: defineHarness({
      name: "scripted",
      async *run(turn) {
        yield { type: "text", delta: "checking" };
        for (let i = 0; i < CALLS; i += 1) await turn.tools.call("maple_invoices_list", {});
        yield { type: "text", delta: "done" };
      },
    }),
  });
  vendo.actions.add(hostTools);

  // AFTER createVendo — composition installs its own sink at boot, so an
  // earlier install would simply be replaced.
  const posted: unknown[] = [];
  const pipeline = createSdkEvents({
    cloud: { apiKey: "vnd_test_phases" },
    env: {},
    runtime: "node",
    fetchImpl: async (_input, init) => {
      posted.push(JSON.parse(String(init?.body)));
      return Response.json({ accepted: 1 }, { status: 202 });
    },
  });
  setUsageSink(pipeline?.record);

  const turn = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_phases",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "list my invoices" }] } as UIMessage,
    }),
  }));
  expect(await turn.text()).toContain("done");
  await pipeline?.flush();

  const events = posted.flatMap((body) => (body as { events: VendoUsageEvent[] }).events);
  const run = events.find((event): event is AgentRun => event.name === "agent_run");
  expect(run).toBeDefined();
  expect(run).toMatchObject({ toolCalls: CALLS, outcome: "ok" });

  // The two marks this test exists for: both really ran, and both carry EVERY
  // call's time, not just one's.
  expect(run!.guardMs).toBeGreaterThanOrEqual(PHASE_MS * CALLS);
  expect(run!.toolsMs).toBeGreaterThanOrEqual(PHASE_MS * CALLS);

  // The split still never claims more than the turn took — the guard phase and
  // the tool phase are disjoint, so neither is counted into the other and
  // `modelMs`'s subtraction stays non-negative.
  const split = run!.storeMs + run!.promptMs + run!.modelMs + run!.toolsMs + run!.guardMs;
  expect(split).toBeLessThanOrEqual(run!.durationMs);
});
