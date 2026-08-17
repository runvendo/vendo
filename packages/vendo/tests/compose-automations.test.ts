/**
 * The umbrella's half of code-authored automations. `@vendoai/agents` may not
 * import `@vendoai/automations`, so `agent.on(...)` only COLLECTS — this is the
 * one place declarations become records, and the one place a firing's brain is
 * registered by name.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent, type VendoAgent } from "@vendoai/agents";
import { createStore, createStoreOps, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { armDevTicker, CODE_AUTOMATION_OWNER } from "../src/compose-automations.js";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const model = {} as LanguageModel;

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-compose-automations-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const named = (name: string): VendoAgent => agent({ name, model });

async function compose(config: Parameters<typeof createVendo>[0]): Promise<Vendo> {
  const vendo = createVendo(config);
  // The boot reconcile rides the ready() latch, so the first touch is boot.
  await vendo.handler(new Request("https://host.test/api/vendo/status"));
  return vendo;
}

const ownerCtx = {
  principal: CODE_AUTOMATION_OWNER,
  venue: "automation",
  presence: "away",
  sessionId: "session_compose_automations_test",
} as const;

describe("boot reconcile — `.on()` declarations become records", () => {
  it("arms what the code declares, and does it once however many boots there are", async () => {
    const store = await tempStore();
    const support = named("support");
    support.on("0 9 * * 1", "summarize the week and email ops");

    const vendo = await compose({ models: { default: model }, principal: async () => null, store, agents: [support] });
    const first = await vendo.automations.list({}, ownerCtx);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ agent: "support", armed: true, authoredBy: "code" });

    // A redeploy: same declaration, same identity, nothing new.
    const again = await compose({ models: { default: model }, principal: async () => null, store, agents: [support] });
    expect(await again.automations.list({}, ownerCtx)).toHaveLength(1);
  });

  it("disarms what the code stopped saying — including an agent dropped from `agents: []`", async () => {
    const store = await tempStore();
    const support = named("support");
    support.on("0 9 * * 1", "summarize the week and email ops");
    const armed = await compose({ models: { default: model }, principal: async () => null, store, agents: [support] });
    const [record] = await armed.automations.list({}, ownerCtx);

    // The agent is gone from the config; its consent was the code.
    const without = await compose({ models: { default: model }, principal: async () => null, store });
    const after = await without.automations.get(record!.id, ownerCtx);
    expect(after).toMatchObject({ armed: false });
    // Disarmed, never deleted — the run history survives, and it is NOT the
    // person's kill switch, so re-adding the declaration re-arms it.
    expect(after?.disarmedBy).toBeUndefined();
    const rearmed = await compose({ models: { default: model }, principal: async () => null, store, agents: [support] });
    expect(await rearmed.automations.get(record!.id, ownerCtx)).toMatchObject({ armed: true });
  });

  it("leaves a record a PERSON disarmed alone — the kill switch survives a redeploy", async () => {
    const store = await tempStore();
    const support = named("support");
    support.on("0 9 * * 1", "summarize the week and email ops");
    const vendo = await compose({ models: { default: model }, principal: async () => null, store, agents: [support] });
    const [record] = await vendo.automations.list({}, ownerCtx);
    await vendo.automations.disable(record!.id, ownerCtx);

    const redeployed = await compose({ models: { default: model }, principal: async () => null, store, agents: [support] });
    expect(await redeployed.automations.get(record!.id, ownerCtx)).toMatchObject({
      armed: false,
      disarmedBy: "user",
    });
  });
});

describe("the named-runner map — registered at BOOT, looked up at fire time", () => {
  // The map's own throw is proven in @vendoai/automations; what is proven HERE is
  // the boot register loop that feeds it — the umbrella is the only place that
  // can, because the dependency guard forbids @vendoai/agents from importing
  // @vendoai/automations. It throws at COMPOSE, not at 2am, when a firing that
  // looked the name up would already have reached the wrong brain.
  it("refuses to compose when two agents in `agents: []` wear one name", async () => {
    const store = await tempStore();
    expect(() => createVendo({
      models: { default: model },
      principal: async () => null,
      store,
      agents: [named("support"), named("support")],
    })).toThrow(/two agents are registered as "support"/);
  });

  it("refuses to compose when an `agents: []` name collides with the ADOPTED agent's", async () => {
    // The adopted agent brings the store (`store` is one of AGENT_OWNED_KEYS), so
    // this composition must NOT also pass one — that conflict is refused earlier,
    // and passing both would never reach the runner map this test is about.
    const agentWithStore = agent({ name: "support", model, store: await tempStore() });
    expect(() => createVendo({
      models: { default: model },
      principal: async () => null,
      agent: agentWithStore,
      agents: [named("support")],
    })).toThrow(/two agents are registered as "support"/);
  });

  it("refuses a value `agent()` did not build, naming the fix", async () => {
    const store = await tempStore();
    expect(() => createVendo({
      models: { default: model },
      principal: async () => null,
      store,
      agents: [{ name: "impostor" } as unknown as VendoAgent],
    })).toThrow(/agent\(\{ name/);
  });
});

/** What a store answers for a collection its engine allowlist does not carry —
 *  Vendo Cloud's did not carry `vendo_automations` in 0.27.0 — wearing the shape
 *  a SECOND copy of `@vendoai/core` mints (a host bundle's dist/cjs beside its
 *  dist/), which is what carried it past every `instanceof VendoError` on the
 *  way out. */
const collectionRefused = (collection: string): Error =>
  Object.assign(new Error(`${collection} is not enabled for this deployment`), {
    name: "VendoError",
    code: "blocked",
  });

/** A store whose engine refuses ONE collection on every verb and serves every
 *  other — the shape of an engine allowlist, which is where the field refusal
 *  came from. `VendoStore.ops` wins over the local surface (`selectStoreOps`),
 *  so this is the same seam a hosted store fills. */
function refuse(store: VendoStore, collection: string): VendoStore {
  const real = createStoreOps(store);
  store.ops = {
    ...real,
    engine: new Proxy(real.engine, {
      get: (target, verb) => async (...args: unknown[]) => {
        if (args[0] === collection) throw collectionRefused(collection);
        return await (Reflect.get(target, verb) as (...rest: unknown[]) => Promise<unknown>).apply(target, args);
      },
    }),
  };
  return store;
}

describe("a store that will not hold automations does not take the deployment with it", () => {
  it("keeps serving every other route, and says why once", async () => {
    // Read off the CONSOLE, not off `setLogger`: a host process can hold two
    // copies of `@vendoai/core` (this suite does), and only one of them has the
    // sink a test installed — while both default to the console line.
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const support = named("support");
    support.on("0 9 * * 1", "summarize the week and email ops");
    const vendo = createVendo({
      models: { default: model },
      principal: async () => ({ kind: "user", subject: "user_reconcile" }),
      store: refuse(await tempStore(), "vendo_automations"),
      agents: [support],
    });

    // THE BRICK (0.27.0 on Cloud keys): the boot reconcile rides the ready()
    // latch, the latch MEMOIZES its rejection, and every route answered 501
    // forever after — including every route that never touches an automation.
    expect((await vendo.handler(new Request("https://host.test/api/vendo/status"))).status).toBe(200);
    expect((await vendo.handler(new Request("https://host.test/api/vendo/status"))).status).toBe(200);

    const said = warnings.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("automations store"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("everything else serves");
  });
});

describe("armDevTicker — the newest composition ADOPTS the ticker", () => {
  it("a replacement composition stops the stale ticker and runs its own (#1250)", () => {
    // Adopt, never duplicate — and never leave the FIRST composition's ticker
    // firing through a retired engine forever (PR #1254 review): arming stops
    // the predecessor's interval and starts the newcomer's.
    const host: Record<symbol, unknown> = {};
    let stopsA = 0;
    let startsB = 0;
    armDevTicker(() => () => { stopsA += 1; }, host);
    expect(stopsA).toBe(0);
    armDevTicker(() => { startsB += 1; return () => undefined; }, host);
    expect(stopsA).toBe(1);
    expect(startsB).toBe(1);
  });
});
