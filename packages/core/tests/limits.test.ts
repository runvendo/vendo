import { describe, expect, it } from "vitest";
import {
  limitActionSchema,
  limitDecisionSchema,
  limitWindowSchema,
  type LimitUser,
  type LimitsCallback,
} from "../src/limits.js";
import type { StoreOps, UsageEvent } from "../src/store.js";

const user: LimitUser = {
  kind: "user",
  subject: "user_ada",
  display: "Ada",
  facts: { plan: "free" },
  pools: ["org_acme"],
};

/** The two things a per-user limit is counted in. */
describe("limitActionSchema", () => {
  it("accepts the two metered actions and rejects anything else", () => {
    expect(limitActionSchema.parse("message")).toBe("message");
    expect(limitActionSchema.parse("generation")).toBe("generation");
    expect(limitActionSchema.safeParse("tool-call").success).toBe(false);
  });
});

/** The stretch of usage a meter read covers. */
describe("limitWindowSchema", () => {
  it("accepts an empty window, each duration field, an instant floor, and a pool", () => {
    expect(limitWindowSchema.safeParse({}).success).toBe(true);
    expect(limitWindowSchema.parse({ days: 30, hours: 1, minutes: 5 })).toMatchObject({ days: 30 });
    expect(limitWindowSchema.parse({ since: new Date("2026-08-01T00:00:00.000Z"), pool: "org_acme" }))
      .toMatchObject({ pool: "org_acme" });
  });

  it("rejects a non-numeric duration and an ISO string where an instant belongs", () => {
    expect(limitWindowSchema.safeParse({ days: "30" }).success).toBe(false);
    expect(limitWindowSchema.safeParse({ since: "2026-08-01T00:00:00.000Z" }).success).toBe(false);
  });
});

/** What a host's policy answers with. */
describe("limitDecisionSchema", () => {
  it("accepts both booleans and a denial with and without a message", () => {
    expect(limitDecisionSchema.parse(true)).toBe(true);
    expect(limitDecisionSchema.parse(false)).toBe(false);
    expect(limitDecisionSchema.parse({ allow: false })).toMatchObject({ allow: false });
    expect(limitDecisionSchema.parse({ allow: false, message: "Daily limit reached" }))
      .toMatchObject({ message: "Daily limit reached" });
  });

  it("rejects an allowing object — allowing is spelled `true`, never `{ allow: true }`", () => {
    expect(limitDecisionSchema.safeParse({ allow: true }).success).toBe(false);
    expect(limitDecisionSchema.safeParse({ message: "nope" }).success).toBe(false);
  });
});

/** The host-supplied policy: the resolved user, the action, and a meter reader
    already bound to that user. */
describe("LimitsCallback", () => {
  it("reads the meter for the current user and denies with a message", async () => {
    const policy: LimitsCallback = async ({ user: who, action, count }) =>
      who.facts?.plan === "free" && (await count(action, { days: 1 })) >= 20
        ? { allow: false, message: "Daily limit reached" }
        : true;

    const count = async (): Promise<number> => 20;
    expect(await policy({ user, action: "message", count })).toMatchObject({ allow: false });
    expect(await policy({ user: { ...user, facts: { plan: "pro" } }, action: "message", count })).toBe(true);
  });
});

/** The meter behind the policy: the three ops a limit is counted with. */
describe("StoreOps.usage", () => {
  it("records an event, counts by subject or by pool, and tallies a window", async () => {
    const events: UsageEvent[] = [];
    const usage: NonNullable<StoreOps["usage"]> = {
      record: async (event) => void events.push(event),
      count: async (query) => events.filter((e) => e.subject === query.subject && e.action === query.action).length,
      tally: async () => events.map((e) => ({ subject: e.subject, action: e.action, count: 1 })),
    };

    await usage.record({ subject: "user_ada", action: "message", at: new Date(), poolKeys: ["org_acme"] });
    expect(await usage.count({ subject: "user_ada", action: "message", since: new Date(0) })).toBe(1);
    expect(await usage.count({ poolKey: "org_acme", action: "message", since: new Date(0) })).toBe(0);
    expect(await usage.tally({ since: new Date(0) })).toMatchObject([{ subject: "user_ada", count: 1 }]);
  });
});
