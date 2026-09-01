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
 *
 * BOTH SIDES OF THAT COMPARISON MUST BE ON ONE CLOCK, which is the whole
 * difficulty. `storeMs` is a duration measured from inside the turn; the obvious
 * `Date.now() - <before handler()>` is not, because it also counts the wire's
 * routing, the principal resolve and the composition's `ready()` latch, none of
 * which the turn's own marks include. Measured: `directionsAt` came out at 17-20ms
 * against a `durationMs` of 11-13ms — larger than the whole turn it was supposed
 * to sit inside. Warm, both collapsed to 0-2ms and `Date.now()`'s millisecond
 * floor decided the result, which is how this test spent its life as a coin flip
 * (4/5 locally on the commit that first went red in CI).
 *
 * So the turn's own origin is recovered from the turn's own numbers: the usage
 * sink fires where `durationMs` is computed, so `postedAt - durationMs` is the
 * instant composition started counting, on this test's clock. Everything below
 * is relative to that.
 *
 * And the boot is paid WITHOUT spending a turn on it. It has to be paid — a
 * PGlite open plus its migrations dwarfs everything here — but the warm-up TURN
 * that used to pay it also spent the store phase this test needs a span of,
 * leaving `storeMs` at 1-2ms. The store's FIRST turn is 6-9ms, which is the
 * margin the assertion reads.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, ToolDescriptor, ToolRegistry, RunContext, VendoUsageEvent } from "../src/core/index.js";
import { setUsageSink } from "../src/core/index.js";
import { createGuard, type VendoGuard } from "../src/guard/index.js";
import { defineHarness } from "../src/harnesses/index.js";
import { memoryStoreAdapter } from "../src/core/conformance/index.js";
import { createStore } from "../src/store/index.js";
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

  /** When prompt assembly reached the guard — an absolute instant, put on the
   *  turn's own origin below rather than measured from outside the handler. */
  let directionsAt: number | undefined;
  /** When composition posted the run event, which is where it computed
   *  `durationMs` — the one place the turn's clock and this one meet. */
  let runPostedAt = 0;

  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: watchDirections(
      createGuard({ store: memoryStoreAdapter(), policy: {} }),
      () => { directionsAt ??= Date.now(); },
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

  // The boot, paid outside the measured window and without spending a turn:
  // opening the embedded database and ensuring its schema is ~550ms and would
  // swamp everything here, but a warm-up TURN would also consume the store phase
  // that the assertion needs a span of.
  await store.ensureSchema();
  setUsageSink((event) => {
    if (event.name === "agent_run") runPostedAt = Date.now();
    posted.push(event);
  });
  directionsAt = undefined;

  const turn = await vendo.handler(post("thr_overlap"));
  expect(await turn.text()).toContain("done");

  const run = posted.find((event): event is AgentRun => event.name === "agent_run");
  expect(run).toBeDefined();
  expect(directionsAt).toBeDefined();
  // The turn's own origin, recovered from the turn's own numbers.
  const turnBegan = runPostedAt - run!.durationMs;
  const startedPromptAt = directionsAt! - turnBegan;
  // The store phase is a real span on this turn — without one there is nothing
  // for the prompt to have overlapped and the assertion below would be vacuous.
  expect(run!.storeMs).toBeGreaterThan(0);
  // THE assertion: prompt assembly began before the store phase had finished.
  // Proven to have teeth by mutation — start `config.system(...)` 50ms late in
  // harness-turn.ts and this reads 52 against a storeMs of 10.
  expect(startedPromptAt).toBeLessThan(run!.storeMs);
  // S1's split still adds up — an overlapped span is billed once, to whichever
  // phase was still waiting, so the four marks can never over-claim the turn.
  expect(run!.storeMs + run!.promptMs + run!.modelMs + run!.toolsMs + run!.guardMs)
    .toBeLessThanOrEqual(run!.durationMs);
});
