import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { AUTOMATION_ID, FixtureTools, call, context, descriptor, seedGrant } from "../fixtures/tools.js";

// 05 §6: an away grant binds to the identity the ctx ACTUALLY CARRIES, and the
// two arms are mutually exclusive. An automation firing carries
// `trigger.automationId` and is matched on that alone — a record holds no app
// reference. A boxed ("machine", layer-2) app callback carries no automation
// identity at all, only the app it runs as (`wire/box.ts` mints
// `{ venue: "app", presence: "away", appId }` with no trigger), so it is matched
// on `appId`. Exclusivity is the security half of the rule: an app-bound grant
// must never authorize an automation firing that merely happens to carry an
// appId, or one app's yes would ride every automation in it.
describe("away grants bind to the identity the ctx carries (05 §6)", () => {
  /** A boxed app's server-side callback, byte-for-byte the ctx `wire/box.ts` builds. */
  const boxCtx = (appId = "app_1") =>
    context({ venue: "app", presence: "away", sessionId: `box_${appId}`, appId });

  /** An automation FIRING, which may also name the app it renders into. */
  const automationCtx = (appId?: string) =>
    context({
      venue: "automation",
      presence: "away",
      ...(appId === undefined ? {} : { appId }),
      trigger: { runId: "run_away", kind: "host-event", automationId: AUTOMATION_ID },
    });

  it("an automation-bound grant authorizes the firing that names that automation", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_atm_bound" });
    await seedGrant(store, { descriptor: d, automationId: AUTOMATION_ID, source: "automation" });
    const guard = createGuard({ store });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    await expect(guard.check(call(d.name, { amount: 1 }, "call_atm"), d, automationCtx()))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });
    await expect(bound.execute(call(d.name, { amount: 1 }, "call_atm"), automationCtx()))
      .resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("an app-bound grant authorizes a boxed app's away callback", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_app_bound" });
    // Exactly the row the automations enable flow mints for a boxed app: bound to
    // the app, source "automation", naming no automation id.
    await seedGrant(store, { descriptor: d, appId: "app_1", source: "automation" });
    const guard = createGuard({ store });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    await expect(guard.check(call(d.name, { amount: 1 }, "call_box"), d, boxCtx()))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });
    await expect(bound.execute(call(d.name, { amount: 1 }, "call_box"), boxCtx()))
      .resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("that same app-bound grant does NOT authorize an automation firing in that app", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_app_bound" });
    await seedGrant(store, { descriptor: d, appId: "app_1", source: "automation" });
    const guard = createGuard({ store });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    // The ctx carries an automation identity, so ONLY an automation-bound grant
    // can satisfy it. The app match is not available as a fallback.
    await expect(guard.check(call(d.name, { amount: 1 }, "call_x"), d, automationCtx("app_1")))
      .resolves.toMatchObject({ action: "ask", decidedBy: "default" });
    await expect(bound.execute(call(d.name, { amount: 1 }, "call_x"), automationCtx("app_1")))
      .resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
  });

  it("a FIRING carrying an appId but no automation id does NOT ride the app-bound grant", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_app_bound" });
    await seedGrant(store, { descriptor: d, appId: "app_1", source: "automation" });
    const guard = createGuard({ store });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    // The discriminator between the arms is the TRIGGER, not `trigger.automationId`:
    // this run carries one, so it is a firing and is bound to the record it fires —
    // and it names none, so it rides nothing. Falling through to the app arm here
    // would let one app's yes authorize every automation inside it.
    const firing = context({
      venue: "automation",
      presence: "away",
      appId: "app_1",
      trigger: { runId: "run_unkeyed", kind: "schedule" },
    });
    await expect(guard.check(call(d.name, { amount: 1 }, "call_unkeyed"), d, firing))
      .resolves.toMatchObject({ action: "ask", decidedBy: "default" });
    await expect(bound.execute(call(d.name, { amount: 1 }, "call_unkeyed"), firing))
      .resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
  });

  it("an automation-bound grant does NOT authorize a boxed app's away callback", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_atm_only" });
    await seedGrant(store, { descriptor: d, automationId: AUTOMATION_ID, source: "automation" });
    const guard = createGuard({ store });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    // The box carries no automation identity, so it matches on the app — and this
    // grant names none. An automation's consent is not the box's to spend.
    await expect(guard.check(call(d.name, { amount: 1 }, "call_y"), d, boxCtx()))
      .resolves.toMatchObject({ action: "ask", decidedBy: "default" });
    await expect(bound.execute(call(d.name, { amount: 1 }, "call_y"), boxCtx()))
      .resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
  });
});
