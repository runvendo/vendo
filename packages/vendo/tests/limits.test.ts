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
import { afterEach, describe, expect, it } from "vitest";
import { createLimiter } from "../src/limits.js";

type Meter = NonNullable<StoreOps["usage"]>;

const meter = (): Meter => memoryStoreOps().usage as Meter;

const ALL_TIME = new Date(0);
const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);

const ctxFor = (over: Partial<RunContext> = {}): RunContext => ({
  principal: { kind: "user", subject: "mia" },
  venue: "chat",
  presence: "present",
  sessionId: "sess_limits",
  ...over,
});

afterEach(() => {
  setLogger(undefined);
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
      email: "mia@maple.test",
      facts: { email: "mia@maple.test", plan: "free" },
      pools: ["workspace"],
    });
  });
});
