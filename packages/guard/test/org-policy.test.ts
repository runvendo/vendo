import { VendoError } from "@vendoai/core";
import type { AuditEvent } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { parseOrgPolicyFile } from "../src/org-policy.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice, call, context, descriptor, FixtureTools, seedGrant } from "./fixtures/tools.js";

/** Contract §9.10 — the org-admin policy layer: a post-pipeline strictness
 *  clamp that TIGHTENS a draft decision and can never loosen one. Every gate
 *  here ships its red half: the same call with the org rule removed (or
 *  pointed elsewhere) must reach the opposite outcome, or the clamp is
 *  decorative. */
describe("org policy — the file format", () => {
  it("parses a tighten-only rule set", () => {
    const rules = parseOrgPolicyFile(
      JSON.stringify({
        format: "vendo/org-policy@1",
        rules: [{ match: { risk: "write" }, action: "ask" }],
      }),
      "org maple",
    );
    expect(rules).toEqual([{ match: { risk: "write" }, action: "ask" }]);
  });

  it("refuses action \"run\" — org policy tightens, never loosens", () => {
    expect(() => parseOrgPolicyFile(
      JSON.stringify({
        format: "vendo/org-policy@1",
        rules: [{ match: { risk: "destructive" }, action: "run" }],
      }),
      "org maple",
    )).toThrow(VendoError);
  });

  it("refuses a foreign format tag", () => {
    expect(() => parseOrgPolicyFile(
      JSON.stringify({ format: "vendo/policy@1", rules: [] }),
      "org maple",
    )).toThrow(VendoError);
  });

  it("refuses malformed JSON", () => {
    expect(() => parseOrgPolicyFile("{not json", "org maple")).toThrow(VendoError);
  });
});

describe("org policy — the strictness clamp", () => {
  const orgWrite = { match: { risk: "write" as const }, action: "ask" as const };

  it("clamps a GRANT-authorized away run to ask", async () => {
    const store = createMemoryStore();
    const write = descriptor("write", { name: "host_org_write" });
    await seedGrant(store, { descriptor: write, appId: "app_1", source: "automation" });
    const ctx = context({ venue: "automation", presence: "away", appId: "app_1" });

    const unclamped = createGuard({ store });
    await expect(unclamped.check(call(write.name, {}, "call_red"), write, ctx))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });

    const clamped = createGuard({ store, orgPolicy: async () => [orgWrite] });
    await expect(clamped.check(call(write.name, {}, "call_green"), write, ctx))
      .resolves.toMatchObject({ action: "ask", decidedBy: "org" });
  });

  it("clamps a present rule-authorized run to block", async () => {
    const store = createMemoryStore();
    const read = descriptor("read", { name: "host_org_read" });
    const ctx = context();
    const policy = { rules: [{ match: { tool: read.name }, action: "run" as const }] };

    const unclamped = createGuard({ store, policy });
    await expect(unclamped.check(call(read.name, {}, "call_red"), read, ctx))
      .resolves.toMatchObject({ action: "run", decidedBy: "rule" });

    const clamped = createGuard({
      store,
      policy,
      orgPolicy: async () => [{ match: { tool: read.name }, action: "block" }],
    });
    await expect(clamped.check(call(read.name, {}, "call_green"), read, ctx))
      .resolves.toMatchObject({ action: "block", decidedBy: "org" });
  });

  it("never loosens a host block", async () => {
    const store = createMemoryStore();
    const write = descriptor("write", { name: "host_blocked" });
    const guard = createGuard({
      store,
      policy: { rules: [{ match: { tool: write.name }, action: "block" }] },
      // The strictest thing org policy can say is still weaker than the host's
      // block — and "ask" must not talk it down.
      orgPolicy: async () => [{ match: {}, action: "ask" }],
    });

    await expect(guard.check(call(write.name, {}, "call_1"), write, context()))
      .resolves.toMatchObject({ action: "block", decidedBy: "rule" });
  });

  it("never loosens a host ask", async () => {
    const store = createMemoryStore();
    const write = descriptor("write", { name: "host_asked" });
    const guard = createGuard({
      store,
      policy: { rules: [{ match: { tool: write.name }, action: "ask" }] },
      orgPolicy: async () => [{ match: {}, action: "ask" }],
    });

    await expect(guard.check(call(write.name, {}, "call_1"), write, context()))
      .resolves.toMatchObject({ action: "ask", decidedBy: "rule" });
  });

  it("leaves a call no org rule matches exactly as the pipeline decided", async () => {
    const store = createMemoryStore();
    const read = descriptor("read", { name: "host_unmatched" });
    const guard = createGuard({
      store,
      orgPolicy: async () => [{ match: { tool: "host_something_else" }, action: "block" }],
    });

    await expect(guard.check(call(read.name, {}, "call_1"), read, context()))
      .resolves.toMatchObject({ action: "run", decidedBy: "default" });
  });

  it("records decidedBy \"org\" on the audit row", async () => {
    const store = createMemoryStore();
    const read = descriptor("read", { name: "host_audited" });
    const guard = createGuard({
      store,
      orgPolicy: async () => [{ match: { tool: read.name }, action: "block" }],
    });

    await guard.check(call(read.name, {}, "call_1"), read, context());
    const { events } = await guard.audit.query({ kind: "policy-decision" });
    expect(events.map((event: AuditEvent) => event.decidedBy)).toContain("org");
  });

  it("applies no org rules when the resolver fails, and audits the gap", async () => {
    const store = createMemoryStore();
    const read = descriptor("read", { name: "host_unreadable_policy" });
    const guard = createGuard({
      store,
      orgPolicy: async () => { throw new VendoError("validation", "Invalid org policy for org maple"); },
    });

    // No silent LOOSENING and no silent tightening either: the draft stands,
    // and the gap is on the record.
    await expect(guard.check(call(read.name, {}, "call_1"), read, context()))
      .resolves.toMatchObject({ action: "run", decidedBy: "default" });
    const { events } = await guard.audit.query({ kind: "policy-decision" });
    expect(events.some((event: AuditEvent) =>
      (event.detail as { reason?: string } | undefined)?.reason === "org-policy-unavailable")).toBe(true);
  });

  /** F2 — an org "ask" has to be SATISFIABLE. The approval the clamp parks is
   *  consumed on the very next check, which the pipeline reports as a
   *  run/"grant" with no grantId (THE LAW's own replay carve-out). Re-clamping
   *  that made "ask" mean park-approve-park forever: the user could never get
   *  the call through. */
  it("lets the approval it parked actually satisfy the call", async () => {
    const store = createMemoryStore();
    const guard = createGuard({
      store,
      orgPolicy: async () => [{ match: { tool: "host_write" }, action: "ask" }],
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const toolCall = call("host_write", { amount: 5 }, "call_org_ask");

    const parked = await bound.execute(toolCall, context());
    expect(parked).toMatchObject({ status: "pending-approval" });
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    await expect(bound.execute(toolCall, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
    // Single-use as ever: the next identical replay parks again.
    await expect(bound.execute(toolCall, context())).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(1);
  });

  it("still binds a STANDING grant — an org ask over a remembered grant is confirm-every-time", async () => {
    const store = createMemoryStore();
    const write = descriptor("write", { name: "host_standing" });
    await seedGrant(store, { descriptor: write });
    const ctx = context();

    const unclamped = createGuard({ store });
    await expect(unclamped.check(call(write.name, {}, "call_red"), write, ctx))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });

    const clamped = createGuard({
      store,
      orgPolicy: async () => [{ match: { tool: write.name }, action: "ask" }],
    });
    await expect(clamped.check(call(write.name, {}, "call_green"), write, ctx))
      .resolves.toMatchObject({ action: "ask", decidedBy: "org" });
  });

  it("clamps ahead of THE LAW, which still refuses the unattended destructive call", async () => {
    const store = createMemoryStore();
    const destructive = descriptor("destructive", { name: "host_org_delete" });
    await seedGrant(store, { descriptor: destructive, appId: "app_1", source: "automation" });
    const guard = createGuard({ store, orgPolicy: async () => [{ match: {}, action: "ask" }] });
    const ctx = context({ venue: "automation", presence: "away", appId: "app_1" });

    // The clamp turns the grant-run into an ask — the law's own
    // prepare-then-human-sends path — rather than an unattended execution.
    await expect(guard.check(call(destructive.name, {}, "call_1"), destructive, ctx))
      .resolves.toMatchObject({ action: "ask", decidedBy: "org" });
  });
});
