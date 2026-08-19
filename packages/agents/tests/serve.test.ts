/**
 * `serve()` — the lifecycle that turns `.on()` declarations into armed records
 * and ticks them. Real store, real engine, real reconcile, real away runner:
 * only the thinker is scripted, and the store is read back through its own doors
 * (CLAUDE.md: test the SEAM).
 */
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendoAgent } from "../src/agent.js";
import { agent } from "../src/agent.js";
import { serve } from "../src/serve.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = (): VendoStore => createStore({ dataDir: `memory://agents-serve-${stores++}` });

/** An agent whose brain does nothing but sign the visitors' book, so a firing is
 *  observable as "this name's runner ran". */
const spy = (name: string, fired: string[], store: VendoStore): VendoAgent => agent({
  name,
  store,
  harness: defineHarness({
    name: "spy",
    async *run() {
      fired.push(name);
      yield { type: "text" as const, delta: `${name} ran.` };
    },
  }),
});

const rows = async (store: VendoStore, collection: string): Promise<unknown[]> =>
  (await store.records(collection).list()).records.map((record) => record.data);

/** Only the scheduler's own interval is faked: the tick's store work is real
 *  async I/O, so `setTimeout` (and everything polling on it) stays real. */
const fakeTicker = (): void => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
};

afterEach(() => {
  vi.useRealTimers();
});

describe("serve()", () => {
  it("a declaration is INERT until serve(): nothing is stored and nothing fires", async () => {
    fakeTicker();
    const fired: string[] = [];
    const store = memoryStore();
    const support = spy("support", fired, store);
    support.on({ at: "2020-01-01T00:00:00.000Z" }, "summarize the week and email ops");

    await store.ensureSchema();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await rows(store, "vendo_automations")).toEqual([]);
    expect(fired).toEqual([]);
  });

  it("reconciles the declaration into an armed record owned by the code", async () => {
    const store = memoryStore();
    const support = spy("support", [], store);
    support.on("0 9 * * 1", "summarize the week and email ops");

    const runtime = await serve({ agents: [support] });
    await runtime.close();

    expect(await rows(store, "vendo_automations")).toMatchObject([{
      owner: { kind: "user", subject: "vendo:code" },
      when: { kind: "schedule", cron: "0 9 * * 1" },
      task: { kind: "goal", prompt: "summarize the week and email ops" },
      agent: "support",
      authoredBy: "code",
      armed: true,
    }]);
  });

  it("a due schedule fires through the agent's own runner, as the code owner", async () => {
    fakeTicker();
    const fired: string[] = [];
    const store = memoryStore();
    const support = spy("support", fired, store);
    // Already past at boot, so the first tick is the due one — the clock the
    // engine reads, rather than a wall-clock wait.
    support.on({ at: "2020-01-01T00:00:00.000Z" }, "summarize the week and email ops");

    const runtime = await serve({ agents: [support] });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect.poll(() => fired, { timeout: 20_000 }).toEqual(["support"]);
    // The ledger's own row: the run belongs to the code owner every declaration
    // shares, and names the agent whose brain ran it.
    await expect.poll(async () => await rows(store, "vendo_runs"), { timeout: 20_000 }).toMatchObject([{
      trigger: { kind: "schedule" },
      status: "ok",
      record: { owner: { kind: "user", subject: "vendo:code" }, agent: "support" },
    }]);
    await runtime.close();
  });

  it("close() stops the ticker: a due schedule no longer fires", async () => {
    fakeTicker();
    const fired: string[] = [];
    const store = memoryStore();
    const support = spy("support", fired, store);
    support.on({ at: "2020-01-01T00:00:00.000Z" }, "summarize the week and email ops");

    const runtime = await serve({ agents: [support] });
    await runtime.close();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(fired).toEqual([]);
    expect(await rows(store, "vendo_runs")).toEqual([]);
  });

  it("each agent brings its own runner, and a firing reaches the one it named", async () => {
    fakeTicker();
    const fired: string[] = [];
    const store = memoryStore();
    const support = spy("support", fired, store);
    const billing = spy("billing", fired, store);
    billing.on({ at: "2020-01-01T00:00:00.000Z" }, "chase the overdue invoices");

    const runtime = await serve({ agents: [support, billing] });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect.poll(() => fired, { timeout: 20_000 }).toEqual(["billing"]);
    await runtime.close();
  });

  it("a secondary's firing parks on the DEPLOYMENT's guard, so the card is collected", async () => {
    fakeTicker();
    const store = memoryStore();
    // The deployment's composition is the FIRST agent's, tools included. Billing
    // brings a brain and its own store, and reaches support's tool.
    const support = agent({
      name: "support",
      store,
      tools: [tool({
        name: "invoices_list",
        description: "List invoices",
        risk: "read",
        inputSchema: { type: "object" },
        execute: () => ({ invoices: 2 }),
      })],
      harness: defineHarness({
        name: "idle",
        async *run() {
          yield { type: "text" as const, delta: "support ran." };
        },
      }),
    });
    const billing = agent({
      name: "billing",
      store: memoryStore(),
      harness: defineHarness({
        name: "caller",
        async *run(turn) {
          await turn.tools.call("invoices_list", {});
          yield { type: "text" as const, delta: "billing asked." };
        },
      }),
    });
    billing.on({ at: "2020-01-01T00:00:00.000Z" }, "chase the overdue invoices");

    const runtime = await serve({ agents: [support, billing] });
    await vi.advanceTimersByTimeAsync(60_000);

    // An away call the guard cannot trace to a grant parks, and the card lands in
    // the store of whichever guard parked it. Parked on billing's own, the
    // deployment's queue — the one a host's permission mount answers from — is
    // empty, and nobody is ever shown the card.
    await expect.poll(() => rows(store, "vendo_approvals"), { timeout: 20_000 }).toMatchObject([{
      status: "pending",
      request: { call: { tool: "invoices_list" } },
    }]);
    // One firing, one store: the ledger row that names it and the thread it thought
    // in are beside the card, not in an agent-private store nobody reads.
    expect(await rows(store, "vendo_runs")).toMatchObject([{
      record: { agent: "billing", steps: [{ tool: "invoices_list", outcome: "pending-approval" }] },
    }]);
    expect(await rows(store, "vendo_threads")).toHaveLength(1);
    await runtime.close();
  });

  it("something that is not an agent() agent names the fix", async () => {
    await expect(serve({ agents: [{ name: "support" } as VendoAgent] })).rejects
      .toThrow("takes the values `agent()` from @vendoai/agents returned");
  });

  it("no agents at all names the fix too", async () => {
    await expect(serve({ agents: [] })).rejects.toThrow("needs at least one agent");
  });

  it("a boot reconcile that fails REJECTS rather than handing back a dead runtime", async () => {
    const store = memoryStore();
    const support = spy("support", [], store);
    support.on("0 9 * * 1", "summarize the week and email ops");
    await store.ensureSchema();
    // The store the reconcile has to read and write is gone. A resolved runtime
    // whose triggers never armed is the one outcome `serve()` may not produce.
    await store.close();

    await expect(serve({ agents: [support] })).rejects.toThrow();
  });
});
