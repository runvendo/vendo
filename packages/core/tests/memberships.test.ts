import { describe, expect, it } from "vitest";
import { membershipSchema, runContextSchema, vendoErrorCodeSchema } from "../src/index.js";
import type { Membership, RunContext } from "../src/index.js";

/** Contract §9.1 — memberships are asserted per request/run and ride the
    RunContext; §9.4 — `forbidden` is the viewer-denied-an-edit code. */
describe("contract §9.1 memberships", () => {
  it("accepts a host-issued org id with optional display, teams, and admin", () => {
    const membership: Membership = {
      org: "acme",
      display: "Acme, Inc.",
      teams: ["finance"],
      admin: true,
    };
    expect(membershipSchema.parse(membership)).toEqual(membership);
    expect(membershipSchema.parse({ org: "acme" })).toEqual({ org: "acme" });
  });

  it("refuses a membership with no org", () => {
    expect(membershipSchema.safeParse({ display: "Acme" }).success).toBe(false);
    expect(membershipSchema.safeParse({ org: "" }).success).toBe(false);
  });

  it("carries memberships on the RunContext", () => {
    const ctx: RunContext = {
      principal: { kind: "user", subject: "u1" },
      venue: "app",
      presence: "present",
      sessionId: "s1",
      memberships: [{ org: "acme", admin: true }],
    };
    expect(runContextSchema.parse(ctx).memberships).toEqual([{ org: "acme", admin: true }]);
  });

  it("leaves memberships absent when nothing is asserted", () => {
    const parsed = runContextSchema.parse({
      principal: { kind: "user", subject: "u1" },
      venue: "app",
      presence: "present",
      sessionId: "s1",
    });
    expect(parsed.memberships).toBeUndefined();
  });
});

describe("contract §9.4 forbidden", () => {
  it("is a VendoErrorCode member", () => {
    expect(vendoErrorCodeSchema.parse("forbidden")).toBe("forbidden");
  });
});
