/**
 * The turn's prompt is assembled BESIDE its store phase, not after it.
 *
 * `config.system(...)` needs only the request's ctx and which discovery rail the
 * harness carries — neither of which the opening reads can change — so a turn
 * that assembled it after them paid the store's wait and the guard's
 * `directions` wait end to end.
 *
 * The proof is an ORDER, not a stopwatch: the guard's `directions()` is the first
 * thing prompt assembly awaits, so the moment it is called is the moment the
 * prompt started. If that moment lands INSIDE the store phase's own span
 * (`storeMs`, marked by composition), the two overlapped. Assembled afterwards,
 * the call could not arrive before `storeMs` had already elapsed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, ToolDescriptor, ToolRegistry, RunContext, VendoUsageEvent } from "@vendoai/core";
import { setUsageSink } from "@vendoai/core";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { defineHarness } from "@vendoai/harnesses";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { createStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

type AgentRun = Extract<VendoUsageEvent, { name: "agent_run" }>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setUsageSink(undefined);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_overlap" };

const hostTools: ToolRegistry = {
  async descriptors(): Promise<ToolDescriptor[]> {
    return [{
      name: "maple_invoices_list",
      title: "List invoices",
      description: "The host's invoice list",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    }];
  },
  async execute() {
    return { status: "ok", output: { invoices: [] } };
  },
};

/**
 * A real guard with ONE method watched. A Proxy rather than a subclass because
 * `VendoGuard` keeps private fields, so every other method has to run with the
 * real instance as its receiver.
 */
function watchDirections(real: VendoGuard, onCall: () => void): VendoGuard {
  return new Proxy(real, {
    get: (target, prop) => {
      if (prop === "directions") {
        return async (ctx: RunContext) => {
          onCall();
          return await real.directions(ctx);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as VendoGuard;
}

it("starts assembling the prompt inside the store phase, not after it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-overlap-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** When prompt assembly reached the guard, relative to the turn's own start. */
  let directionsAt: number | undefined;
  let turnStartedAt = 0;

  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: watchDirections(
      createGuard({ store: memoryStoreAdapter(), policy: {} }),
      () => { directionsAt ??= Date.now() - turnStartedAt; },
    ),
    harness: defineHarness({
      name: "scripted",
      run: async function* () {
        yield { type: "text", delta: "done" };
      },
    }) as never,
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(hostTools);

  const posted: VendoUsageEvent[] = [];
  const post = (threadId: string): Request =>
    new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } as UIMessage,
      }),
    });

  // One turn to pay for the deployment's own boot — opening the embedded
  // database and ensuring its schema happens on the first request and dwarfs
  // everything this test is looking at. The measured turn is the second one, so
  // the clock below starts where `stream()` does.
  await (await vendo.handler(post("thr_warm"))).text();
  setUsageSink((event) => { posted.push(event); });
  directionsAt = undefined;

  turnStartedAt = Date.now();
  const turn = await vendo.handler(post("thr_overlap"));
  expect(await turn.text()).toContain("done");

  const run = posted.find((event): event is AgentRun => event.name === "agent_run");
  expect(run).toBeDefined();
  expect(directionsAt).toBeDefined();
  // The store phase is a real span on this turn — without one there is nothing
  // for the prompt to have overlapped and the assertion below would be vacuous.
  expect(run!.storeMs).toBeGreaterThan(0);
  // THE assertion: prompt assembly began before the store phase had finished.
  expect(directionsAt!).toBeLessThan(run!.storeMs);
  // S1's split still adds up — an overlapped span is billed once, to whichever
  // phase was still waiting, so the four marks can never over-claim the turn.
  expect(run!.storeMs + run!.promptMs + run!.modelMs + run!.toolsMs + run!.guardMs)
    .toBeLessThanOrEqual(run!.durationMs);
});
