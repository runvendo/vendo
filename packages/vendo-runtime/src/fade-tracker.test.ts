import { describe, expect, it } from "vitest";
import { createFadeTracker } from "./fade-tracker.js";

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

  it("propose carries the in-window yes-count for the shape", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" });
    expect(offer?.count).toBe(3);
  });

  it("consume deletes the offer (review follow-up: accept is one-shot)", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    t.consume(p, offer.proposalId);
    expect(t.resolveEligible(p, offer.proposalId)).toBeUndefined();
  });

  it("consume is idempotent-safe against replay and unknown ids", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    t.consume(p, offer.proposalId);
    expect(() => t.consume(p, offer.proposalId)).not.toThrow();
    expect(() => t.consume(p, "not-a-real-id")).not.toThrow();
  });

  it("consume never suppresses — it only removes the ONE offer, not the shape", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    t.consume(p, offer.proposalId);
    // A fresh yes still earns a fresh offer — consuming is not a decline.
    t.record(p, "send_email", { to: "e@acme.co" }, "yes");
    expect(t.propose(p, "send_email", { to: "f@acme.co" })).not.toBeNull();
  });

  it("consume returns the removed offer (finding 4 — so a caller can restore it on a later failure)", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    expect(t.consume(p, offer.proposalId)).toEqual({ tool: "send_email", shape: offer.shape });
    expect(t.consume(p, offer.proposalId)).toBeUndefined(); // already gone — nothing to return
  });

  it("restore puts a consumed offer back so it's eligible again (finding 4 rollback)", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    const claimed = t.consume(p, offer.proposalId)!;
    expect(t.resolveEligible(p, offer.proposalId)).toBeUndefined();
    t.restore(p, offer.proposalId, claimed);
    expect(t.resolveEligible(p, offer.proposalId)).toEqual({ tool: "send_email", shape: offer.shape });
  });

  it("restore never clobbers a DIFFERENT offer that already exists under the same id", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    const claimed = t.consume(p, offer.proposalId)!;
    // A fresh offer minted under the SAME id (deterministic ids can collide
    // if re-proposed with the same shape) before the restore runs.
    for (const to of ["e@acme.co", "f@acme.co", "g@acme.co"]) t.record(p, "send_email", { to }, "yes");
    t.propose(p, "send_email", { to: "h@acme.co" }); // same proposalId (same principal/tool/shape)
    t.restore(p, offer.proposalId, claimed); // must be a no-op — something newer is already there
    expect(t.resolveEligible(p, offer.proposalId)).toEqual({ tool: "send_email", shape: offer.shape });
  });
});
