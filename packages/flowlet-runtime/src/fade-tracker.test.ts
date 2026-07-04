import { describe, expect, it } from "vitest";
import { createFadeTracker } from "./fade-tracker";

const p = { tenantId: "t", subject: "u" };
const other = { tenantId: "t", subject: "u2" };

describe("FadeTracker", () => {
  it("proposes after 3 yes of the same shape, not before", () => {
    const t = createFadeTracker();
    t.record(p, "send_email", { to: "a@acme.co" }, "yes");
    t.record(p, "send_email", { to: "b@acme.co" }, "yes");
    expect(t.propose(p, "send_email", { to: "c@acme.co" })).toBeNull();
    t.record(p, "send_email", { to: "c@acme.co" }, "yes");
    const eligible = t.propose(p, "send_email", { to: "d@acme.co" });
    expect(eligible?.shape).toEqual({ kind: "constrained", path: "to", op: "matches", value: "*@acme.co" });
    expect(eligible?.proposalId).toBeTruthy();
  });

  it("a single no of the same shape blocks eligibility even with 3+ yes", () => {
    const t = createFadeTracker();
    t.record(p, "send_email", { to: "a@acme.co" }, "yes");
    t.record(p, "send_email", { to: "b@acme.co" }, "yes");
    t.record(p, "send_email", { to: "c@acme.co" }, "no");
    t.record(p, "send_email", { to: "d@acme.co" }, "yes");
    expect(t.propose(p, "send_email", { to: "e@acme.co" })).toBeNull();
  });

  it("different shapes never share a count", () => {
    const t = createFadeTracker();
    t.record(p, "send_email", { to: "a@acme.co" }, "yes");
    t.record(p, "send_email", { to: "b@other.co" }, "yes");
    t.record(p, "send_email", { to: "c@third.co" }, "yes");
    expect(t.propose(p, "send_email", { to: "d@acme.co" })).toBeNull();
  });

  it("principals never share state", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    expect(t.propose(other, "send_email", { to: "d@acme.co" })).toBeNull();
  });

  it("the rolling window (default 20) ages out old decisions", () => {
    const t = createFadeTracker({ windowSize: 5, threshold: 3 });
    t.record(p, "send_email", { to: "a@acme.co" }, "yes");
    t.record(p, "send_email", { to: "b@acme.co" }, "yes");
    t.record(p, "send_email", { to: "c@acme.co" }, "yes");
    // 4 unrelated decisions push the 3 yeses out of a window of 5.
    for (let i = 0; i < 4; i++) t.record(p, "other_tool", { to: `x${i}@z.co` }, "yes");
    expect(t.propose(p, "send_email", { to: "d@acme.co" })).toBeNull();
  });

  it("resolveEligible re-verifies live and rejects a stale/forged proposalId", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    expect(t.resolveEligible(p, offer.proposalId)).toEqual({ tool: "send_email", shape: offer.shape });
    expect(t.resolveEligible(p, "not-a-real-id")).toBeUndefined();
    expect(t.resolveEligible(other, offer.proposalId)).toBeUndefined(); // wrong principal
  });

  it("a 'no' recorded AFTER an offer sours resolveEligible (never trust the client)", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    t.record(p, "send_email", { to: "e@acme.co" }, "no");
    expect(t.resolveEligible(p, offer.proposalId)).toBeUndefined();
  });

  it("decline suppresses re-proposal of the exact shape", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    expect(t.decline(p, offer.proposalId)).toEqual({ tool: "send_email", shape: offer.shape });
    t.record(p, "send_email", { to: "f@acme.co" }, "yes"); // more yeses...
    expect(t.propose(p, "send_email", { to: "g@acme.co" })).toBeNull(); // ...still suppressed
  });

  it("decline is idempotent-safe against an unknown id", () => {
    const t = createFadeTracker();
    expect(t.decline(p, "unknown")).toBeUndefined();
  });
});
