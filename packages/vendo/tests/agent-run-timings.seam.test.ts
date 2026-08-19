/**
 * `agent_run`'s latency breakdown, END TO END: the composed turn that measures
 * it, the shipped events pipeline that uploads it, and the batch the console
 * actually receives.
 *
 * The seam is producer/consumer here too. A test that installed its own sink
 * would read numbers the real pipeline never carried, and a test that called
 * `emitUsage` by hand would never touch the marks a turn takes. So: ONE real
 * composed turn through `createVendo`, the SHIPPED `createSdkEvents` pipeline as
 * its sink, and the assertions read off the POSTed body — the same bytes the
 * console's allowlist parses. Only the network is stood in for.
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
import { createVendo } from "../src/server.js";

/** Read back off the wire as the CONTRACT type, so a field this asserts on is a
 *  field the catalog really carries. */
type AgentRun = Extract<VendoUsageEvent, { name: "agent_run" }>;

/** How long the scripted thinker takes before its first word — the floor
 *  `ttftMs` and `modelMs` are asserted against, so a mark that is really zero
 *  cannot pass. */
const THINK_MS = 30;

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
    return { status: "ok", output: { invoices: [] } };
  },
};

it("reports the turn's time-to-first-output, its per-phase split and its real step count", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-run-timings-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const vendo = createVendo({
    // Never reached: the harness below is scripted, so no provider is involved.
    models: { default: {} as LanguageModel },
    principal: async (): Promise<Principal> => ({ kind: "user", subject: "user_timings" }),
    store,
    harness: defineHarness({
      name: "scripted",
      async *run(turn) {
        // Two SEQUENTIAL rounds: the thinker asks, the tool answers, it asks
        // again — three model calls, which is what `steps` has to say.
        await sleep(THINK_MS);
        yield { type: "text", delta: "checking" };
        await turn.tools.call("maple_invoices_list", {});
        await turn.tools.call("maple_invoices_list", {});
        yield { type: "text", delta: "done" };
      },
    }),
  });
  vendo.actions.add(hostTools);

  // AFTER createVendo — composition installs its own sink at boot (undefined
  // without a Cloud key), so an earlier install would simply be replaced. The
  // pipeline is the shipped one; `env: {}` keeps the opt-outs out of it.
  const posted: unknown[] = [];
  const pipeline = createSdkEvents({
    cloud: { apiKey: "vnd_test_timings" },
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
      threadId: "thr_timings",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "list my invoices" }] } as UIMessage,
    }),
  }));
  expect(await turn.text()).toContain("done");
  await pipeline?.flush();

  const events = posted.flatMap((body) => (body as { events: VendoUsageEvent[] }).events);
  const run = events.find((event): event is AgentRun => event.name === "agent_run");
  expect(run).toBeDefined();
  expect(run).toMatchObject({ steps: 3, toolCalls: 2, outcome: "ok" });
  // Time to the first word the user saw — after the thinking, before the end.
  expect(run!.ttftMs).toBeGreaterThanOrEqual(THINK_MS);
  expect(run!.ttftMs).toBeLessThanOrEqual(run!.durationMs);
  // The store phase really ran (the turn opened a database and wrote a row),
  // and the split never claims more than the turn took.
  expect(run!.storeMs).toBeGreaterThan(0);
  expect(run!.modelMs).toBeGreaterThanOrEqual(THINK_MS);
  const split = run!.storeMs + run!.promptMs + run!.modelMs + run!.toolsMs + run!.guardMs;
  expect(split).toBeLessThanOrEqual(run!.durationMs);
});
