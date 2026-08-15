/**
 * The limiter: Vendo counts, the host decides.
 *
 * Every case drives a REAL meter (the conformance reference the SQL backend and
 * the cloud client are held to), because the two things worth proving here are
 * what lands in the drawer and what comes back out of it — a counted double
 * would agree with the limiter about both forever.
 *
 * The fail-closed cases are the point of the file. A limits system that fails
 * OPEN stops limiting silently, which is strictly worse than refusing a turn:
 * the host believes they have a cap, and every user is unlimited.
 */
import { setLogger, type LimitUser, type RunContext, type StoreOps, type VendoLogEvent } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createComposition } from "../src/compose-context.js";
import { createLimiter } from "../src/limits.js";
import { createVendo } from "../src/server.js";

type Meter = NonNullable<StoreOps["usage"]>;

const meter = (): Meter => memoryStoreOps().usage as Meter;

/** The same reference ops with the OPTIONAL family genuinely absent — a store
    with nowhere to meter, which is what composition has to refuse. */
const meterlessOps = (): StoreOps => {
  const { usage: _absent, ...rest } = memoryStoreOps();
  return rest as StoreOps;
};

const ALL_TIME = new Date(0);
const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);

const ctxFor = (over: Partial<RunContext> = {}): RunContext => ({
  principal: { kind: "user", subject: "mia" },
  venue: "chat",
  presence: "present",
  sessionId: "sess_limits",
  ...over,
});

const stores: VendoStore[] = [];
const openStore = (ops: StoreOps): VendoStore => {
  // The real store, with the ops surface under test bound over it: `selectStoreOps`
  // takes `store.ops` when it carries one, so this is the composed seam and not a
  // shortcut around it.
  const store = Object.assign(createStore(), { ops });
  stores.push(store);
  return store;
};

afterEach(async () => {
  setLogger(undefined);
  for (const store of stores.splice(0)) await store.close();
});

describe("the limiter's verdict", () => {
  it("allows, and records the action against the subject", async () => {
    const usage = meter();
    const limiter = createLimiter({ callback: () => true, ops: usage });

    await expect(limiter.gate("message", ctxFor())).resolves.toEqual({ allow: true });
    expect(await usage.count({ action: "message", subject: "mia", since: ALL_TIME })).toBe(1);
  });

  it("denies, and records NOTHING — a refused action was never spent", async () => {
    const usage = meter();
    const limiter = createLimiter({ callback: () => false, ops: usage });

    await expect(limiter.gate("message", ctxFor())).resolves.toEqual({ allow: false });
    expect(await usage.count({ action: "message", subject: "mia", since: ALL_TIME })).toBe(0);
  });

  it("carries the host's own sentence out of a denial", async () => {
    const message = "You have used all 20 messages on Maple Free. It resets on the 1st.";
    const limiter = createLimiter({ callback: () => ({ allow: false, message }), ops: meter() });

    await expect(limiter.gate("generation", ctxFor())).resolves.toEqual({ allow: false, message });
  });
});

describe("the limiter fails CLOSED", () => {
  const logged = (): VendoLogEvent[] => {
    const events: VendoLogEvent[] = [];
    setLogger((event) => events.push(event));
    return events;
  };

  it("denies and says so loudly when the policy THROWS", async () => {
    const events = logged();
    const usage = meter();
    const limiter = createLimiter({
      callback: () => { throw new Error("plan lookup timed out"); },
      ops: usage,
    });

    await expect(limiter.gate("message", ctxFor())).resolves.toEqual({ allow: false });
    expect(events.filter((event) => event.code === "limits.callback_error")).toHaveLength(1);
    expect(await usage.count({ action: "message", subject: "mia", since: ALL_TIME })).toBe(0);
  });

  it("denies and says so loudly when the policy REJECTS", async () => {
    const events = logged();
    const limiter = createLimiter({
      callback: async () => { throw new Error("the plans table is down"); },
      ops: meter(),
    });

    await expect(limiter.gate("message", ctxFor())).resolves.toEqual({ allow: false });
    expect(events.filter((event) => event.code === "limits.callback_error")).toHaveLength(1);
  });

  it("denies on a pool the user is not in — an unknown meter is never a zero", async () => {
    const events = logged();
    const limiter = createLimiter({
      callback: async ({ count }) => (await count("message", { pool: "team" })) < 5,
      ops: meter(),
    });

    await expect(limiter.gate("message", ctxFor({ pools: { workspace: "ws_maple" } })))
      .resolves.toEqual({ allow: false });
    expect(events.filter((event) => event.code === "limits.callback_error")).toHaveLength(1);
  });
});

describe("the meter reader the policy is handed", () => {
  it("counts THIS subject, over the window the policy asked for", async () => {
    const usage = meter();
    await usage.record({ subject: "mia", action: "message", at: hoursAgo(50) });
    await usage.record({ subject: "mia", action: "message", at: hoursAgo(1) });
    await usage.record({ subject: "raj", action: "message", at: hoursAgo(1) });

    const seen: number[] = [];
    const limiter = createLimiter({
      callback: async ({ count }) => {
        seen.push(await count("message", { days: 1 }), await count("message"));
        return true;
      },
      ops: usage,
    });

    await limiter.gate("message", ctxFor());
    expect(seen).toEqual([1, 2]);
  });

  it("ANDs the three durations into one lookback", async () => {
    const usage = meter();
    await usage.record({ subject: "mia", action: "message", at: hoursAgo(25) });
    await usage.record({ subject: "mia", action: "message", at: hoursAgo(27) });

    let counted = 0;
    const limiter = createLimiter({
      callback: async ({ count }) => { counted = await count("message", { days: 1, hours: 2 }); return true; },
      ops: usage,
    });

    await limiter.gate("message", ctxFor());
    expect(counted).toBe(1);
  });

  it("counts a named pool's WHOLE bucket, resolved through ctx.pools", async () => {
    const usage = meter();
    await usage.record({ subject: "mia", action: "message", at: hoursAgo(1), poolKeys: ["ws_maple"] });
    await usage.record({ subject: "raj", action: "message", at: hoursAgo(1), poolKeys: ["ws_maple"] });

    let pooled = 0;
    const limiter = createLimiter({
      callback: async ({ count }) => { pooled = await count("message", { pool: "workspace" }); return true; },
      ops: usage,
    });

    await limiter.gate("message", ctxFor({ pools: { workspace: "ws_maple" } }));
    expect(pooled).toBe(2);
  });

  it("stamps every resolved pool key on what an allow records", async () => {
    const usage = meter();
    const limiter = createLimiter({ callback: () => true, ops: usage });

    await limiter.gate("generation", ctxFor({ pools: { workspace: "ws_maple", org: "org_maple" } }));

    expect(await usage.count({ action: "generation", poolKey: "ws_maple", since: ALL_TIME })).toBe(1);
    expect(await usage.count({ action: "generation", poolKey: "org_maple", since: ALL_TIME })).toBe(1);
  });
});

describe("the user the policy decides about", () => {
  it("is the resolved principal, the host's facts, and the pool NAMES", async () => {
    let seen: LimitUser | undefined;
    const limiter = createLimiter({ callback: ({ user }) => { seen = user; return true; }, ops: meter() });

    await limiter.gate("message", ctxFor({
      principal: { kind: "user", subject: "mia", display: "Mia" },
      user: { email: "mia@maple.test", plan: "free" },
      pools: { workspace: "ws_maple" },
    }));

    expect(seen).toEqual({
      kind: "user",
      subject: "mia",
      display: "Mia",
      facts: { email: "mia@maple.test", plan: "free" },
      pools: ["workspace"],
    });
  });
});

describe("the `limits` config key", () => {
  const base = { principal: async () => null };

  it("wires NOTHING when the host sets no policy", () => {
    const composition = createComposition({ ...base, store: openStore(memoryStoreOps()) });
    expect(composition.limiter).toBeUndefined();
  });

  it("REFUSES at composition against a store with no meter", () => {
    const store = openStore(meterlessOps());
    expect(() => createVendo({ ...base, store, limits: () => true }))
      .toThrow(/no usage meter/);
  });

  it("composes the limiter when the store carries a meter", () => {
    const composition = createComposition({
      ...base,
      store: openStore(memoryStoreOps()),
      limits: () => true,
    });
    expect(composition.limiter).toBeDefined();
  });
});
