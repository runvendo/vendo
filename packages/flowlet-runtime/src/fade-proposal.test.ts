import { describe, expect, it } from "vitest";
import { handleFadeProposal } from "./fade-proposal";
import { createFadeTracker } from "./fade-tracker";
import { createInMemoryGrantStore } from "./grant-store";
import { InMemoryAuditLog } from "./embedded/in-memory-store";
import type { ToolDescriptor } from "./descriptor";

const scope = { tenantId: "t", subject: "u" };
const now = () => "2026-07-04T00:00:00Z";
// ENG-193 §4.4 (Task 5 deviation, same root cause as Task 4's consent.test.ts
// fix): an all-{} annotations object is "unverified" per policy/tier.ts's
// already-landed `isUnverified`, which handleFadeProposal itself gates on —
// explicit readOnlyHint: false marks this fixture VERIFIED, matching intent.
const actDescriptor: ToolDescriptor = {
  name: "GMAIL_SEND_EMAIL", source: "composio", annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
};
const criticalDescriptor: ToolDescriptor = {
  name: "transfer_money", source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};

function offerEligible(tracker = createFadeTracker()) {
  for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) {
    tracker.record(scope, "GMAIL_SEND_EMAIL", { to }, "yes");
  }
  return { tracker, offer: tracker.propose(scope, "GMAIL_SEND_EMAIL", { to: "d@acme.co" })! };
}

function deps(tracker = createFadeTracker(), resolveDescriptor = (n: string) =>
  n === "GMAIL_SEND_EMAIL" ? actDescriptor : n === "transfer_money" ? criticalDescriptor : undefined,
) {
  const grants = createInMemoryGrantStore({ now });
  const audit = new InMemoryAuditLog();
  return { fadeTracker: tracker, grants, audit, resolveDescriptor, now };
}

describe("handleFadeProposal", () => {
  it("accept mints a standing grant matching ONLY the derived shape", async () => {
    const { tracker, offer } = offerEligible();
    const d = deps(tracker);
    const result = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(result.ok).toBe(true);
    const [grant] = await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL");
    expect(grant?.scope).toEqual({
      kind: "constrained", constraints: [{ path: "to", op: "matches", value: "*@acme.co" }],
    });
    expect(grant?.source).toEqual({ kind: "fade" });
    expect(await d.audit.query(scope, { kinds: ["grant_created"] })).toHaveLength(1);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("decline stores a suppression and mints no grant", async () => {
    const { tracker, offer } = offerEligible();
    const d = deps(tracker);
    const result = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: false });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("404s an unknown/expired proposalId", async () => {
    const d = deps();
    const result = await handleFadeProposal(d, scope, { proposalId: "not-real", accept: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(403); // resolveEligible returns undefined -> ineligible, not "not found" per se
  });

  it("INVARIANT: rejects a forged accept when the tracker's OWN state no longer supports it", async () => {
    const { tracker, offer } = offerEligible();
    tracker.record(scope, "GMAIL_SEND_EMAIL", { to: "z@acme.co" }, "no"); // sours it after the offer
    const d = deps(tracker);
    const result = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(result.ok).toBe(false);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
  });

  it("INVARIANT: a second accept of the same proposalId is rejected; exactly one grant is minted", async () => {
    const { tracker, offer } = offerEligible();
    const d = deps(tracker);
    const first = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(first.ok).toBe(true);
    const second = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(second.ok).toBe(false);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
  });

  it("INVARIANT: replaying the proposalId after the minted grant was revoked never silently re-grants", async () => {
    const { tracker, offer } = offerEligible();
    const d = deps(tracker);
    const first = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(first.ok).toBe(true);
    const [grant] = await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL");
    await d.grants.revoke(scope, grant!.id);
    const replay = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(replay.ok).toBe(false);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
  });

  it("INVARIANT: refuses to mint for a tool whose LIVE descriptor is critical (defense in depth)", async () => {
    const tracker = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) {
      tracker.record(scope, "transfer_money", { to }, "yes");
    }
    const offer = tracker.propose(scope, "transfer_money", { to: "d@acme.co" })!;
    const d = deps(tracker);
    const result = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(403);
  });

  it("FINDING 4: two CONCURRENT accepts of the SAME proposalId mint exactly one grant", async () => {
    const { tracker, offer } = offerEligible();
    const d = deps(tracker);
    const [first, second] = await Promise.all([
      handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true }),
      handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true }),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
  });

  it("FINDING 4: a grant-creation failure restores the offer so a corrected retry still succeeds", async () => {
    const { tracker, offer } = offerEligible();
    const realGrants = createInMemoryGrantStore({ now });
    let failNext = true;
    // A GrantStore whose `create` throws exactly once — simulates a transient
    // mint failure (e.g. a store conflict) AFTER the offer has already been
    // claimed synchronously (finding 4's fix).
    const flakyGrants = {
      ...realGrants,
      create: async (...args: Parameters<typeof realGrants.create>) => {
        if (failNext) {
          failNext = false;
          throw new Error("transient store failure");
        }
        return realGrants.create(...args);
      },
    };
    const d = { ...deps(tracker), grants: flakyGrants };

    const failed = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(failed.ok).toBe(false);
    expect(await realGrants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);

    // Retry with the SAME proposalId — the offer must have been restored.
    const retried = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(retried.ok).toBe(true);
    expect(await realGrants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
  });
});
