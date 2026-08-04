import { isRehearsalSimulation } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice, call, context, descriptor, FixtureTools, seedGrant } from "./fixtures/tools.js";

/**
 * Rehearsal venue (07-automations rehearse()): before enabling an automation,
 * its historical firings replay through the guard under venue "rehearsal" —
 * read-risk tools execute for real on the live interactive session,
 * write/destructive-risk tools NEVER execute and resolve to a structured
 * simulated-outcome card carrying the fully resolved arguments. No grants are
 * required, no approvals can park, and every rehearsal call is still audited
 * under the rehearsal venue.
 */
describe("rehearsal venue at the guard choke point", () => {
  const rehearsalCtx = context({ venue: "rehearsal", appId: "app_1" });
  // The Maple demo posture: run-on-read, ask-on-write.
  const demoPolicy = {
    rules: [
      { match: { risk: "destructive" as const }, action: "ask" as const },
      { match: { risk: "write" as const }, action: "ask" as const },
      { match: { risk: "read" as const }, action: "run" as const },
    ],
  };

  it("executes a read for real, with no grants seeded", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_read", { q: 1 }), rehearsalCtx);
    expect(outcome).toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
    expect(tools.executions[0]?.ctx.venue).toBe("rehearsal");
    expect(tools.executions[0]?.ctx.presence).toBe("present");
  });

  it("never executes a write: returns the simulated card with the resolved args + honest verdict", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const args = { to: "user@example.com", body: "Balance is $1,500" };
    const outcome = await guard.bind(tools).execute(call("host_write", args, "call_w"), rehearsalCtx);
    expect(outcome.status).toBe("ok");
    const output = (outcome as { status: "ok"; output: unknown }).output;
    expect(isRehearsalSimulation(output)).toBe(true);
    // The card now also carries what the ENABLED automation WOULD do: under the
    // ask-on-write policy with no grant captured yet, this write would ask.
    expect(output).toEqual({
      rehearsalSimulated: true,
      tool: "host_write",
      risk: "write",
      args,
      wouldAsk: true,
      grantsMissing: ["host_write"],
    });
    // The registry was never reached: nothing executed.
    expect(tools.executions).toHaveLength(0);
  });

  it("never executes a destructive call either — and says it would ask", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_destructive", { id: "x" }), rehearsalCtx);
    expect(outcome.status).toBe("ok");
    const output = (outcome as { status: "ok"; output: unknown }).output;
    expect(isRehearsalSimulation(output)).toBe(true);
    expect(output).toMatchObject({ wouldAsk: true, grantsMissing: ["host_destructive"] });
    expect(tools.executions).toHaveLength(0);
  });

  it("parks NO approvals for writes — the ask-on-write policy never gets to ask, but the card says it WOULD", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const write = await guard.bind(tools).execute(call("host_write", { v: 1 }), rehearsalCtx);
    const destructive = await guard.bind(tools).execute(call("host_destructive", { v: 2 }, "call_2"), rehearsalCtx);
    // Core assertion (unchanged): no approval parks during rehearsal.
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
    // New: the simulated cards now honestly report the would-ask verdict.
    expect((write as { output: unknown }).output).toMatchObject({ wouldAsk: true, grantsMissing: ["host_write"] });
    expect((destructive as { output: unknown }).output).toMatchObject({ wouldAsk: true, grantsMissing: ["host_destructive"] });
  });

  it("a write with an automation-source standing grant reports wouldAsk:false (it would simply run once live)", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, policy: demoPolicy });
    // The verdict resolves under the away/automation context, so only an
    // automation-source, app-bound grant (what enable captures) authorizes it.
    await seedGrant(store, { descriptor: descriptor("write"), source: "automation", appId: "app_1", duration: "standing" });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_write", { v: 1 }), rehearsalCtx);
    expect(outcome.status).toBe("ok");
    // Still simulated (writes never execute in rehearsal), but the verdict is
    // honest: the automation grant means the enabled automation would run it.
    expect((outcome as { output: unknown }).output).toMatchObject({
      rehearsalSimulated: true,
      wouldAsk: false,
      grantsMissing: [],
    });
    expect(tools.executions).toHaveLength(0);
    // Resolving the verdict must NOT have spent/parked anything.
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
  });

  it("a CHAT-source grant does NOT suppress the away verdict: the enabled automation still asks", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, policy: demoPolicy });
    // A chat grant is not usable away — the enabled automation, running away,
    // has no captured automation-source authority, so it would still ask.
    await seedGrant(store, { descriptor: descriptor("write"), source: "chat" });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_write", { v: 1 }), rehearsalCtx);
    expect(outcome.status).toBe("ok");
    expect((outcome as { output: unknown }).output).toMatchObject({
      rehearsalSimulated: true,
      wouldAsk: true,
      grantsMissing: ["host_write"],
    });
    expect(tools.executions).toHaveLength(0);
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
  });

  it("a policy BLOCK rule on a write reports wouldBlock on the simulated card", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: { tool: "host_write" }, action: "block" as const, note: "writes are off in this app" }] },
    });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_write", { v: 1 }), rehearsalCtx);
    expect(outcome.status).toBe("ok");
    expect((outcome as { output: unknown }).output).toMatchObject({
      rehearsalSimulated: true,
      wouldAsk: false,
      grantsMissing: [],
      wouldBlock: "writes are off in this app",
    });
    expect(tools.executions).toHaveLength(0);
  });

  it("a critical write reports wouldAsk:true but NOT as a missing grant (a grant can't suppress critical)", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const critical = descriptor("write", { name: "host_critical_write", critical: true });
    const tools = new FixtureTools([critical]);
    const outcome = await guard.bind(tools).execute(call("host_critical_write"), rehearsalCtx);
    expect(outcome.status).toBe("ok");
    expect((outcome as { output: unknown }).output).toMatchObject({
      rehearsalSimulated: true,
      wouldAsk: true,
      grantsMissing: [],
    });
  });

  it("a would-ask READ blocks instead of parking (rehearsal never asks)", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: { risk: "read" as const }, action: "ask" as const }] },
    });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_read"), rehearsalCtx);
    expect(outcome).toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
  });

  it("a critical read blocks instead of parking (critical always asks; rehearsal cannot)", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const critical = descriptor("read", { name: "host_critical_read", critical: true });
    const tools = new FixtureTools([critical]);
    const outcome = await guard.bind(tools).execute(call("host_critical_read"), rehearsalCtx);
    expect(outcome).toMatchObject({ status: "blocked" });
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
  });

  it("a policy BLOCK rule still blocks a rehearsal read", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: { tool: "host_read" }, action: "block" as const, note: "not in rehearsal" }] },
    });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_read"), rehearsalCtx);
    expect(outcome).toMatchObject({ status: "blocked", reason: "not in rehearsal" });
    expect(tools.executions).toHaveLength(0);
  });

  it("audits rehearsal calls under the rehearsal venue — reads and simulated writes", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    await bound.execute(call("host_read", { q: 1 }, "call_r"), rehearsalCtx);
    await bound.execute(call("host_write", { v: 1 }, "call_w"), rehearsalCtx);
    const { events } = await guard.audit.query({ principal: alice, kind: "tool-call" });
    const rehearsed = events.filter((event) => event.venue === "rehearsal");
    expect(rehearsed).toHaveLength(2);
    const write = rehearsed.find((event) => event.tool === "host_write");
    expect(write?.outcome).toBe("ok");
    expect(write?.detail).toMatchObject({ rehearsalSimulated: true, risk: "write" });
    const read = rehearsed.find((event) => event.tool === "host_read");
    expect(read?.outcome).toBe("ok");
  });

  it("a full-length rehearsal (30 reads) never trips the call-rate breaker on itself", async () => {
    // maxCallsPerMinute:29 is BELOW the 30-firing count on purpose: if rehearsal
    // reads charged the shared window (the regression this guards), the 30th
    // would trip the breaker and block. The default 60 could never catch that.
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy, breakers: { maxCallsPerMinute: 29 } });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    // One read per firing at the automations cap (REHEARSAL_MAX_FIRINGS) —
    // the guard never imports that constant, so this mirrors it deliberately.
    for (let index = 0; index < 30; index += 1) {
      const outcome = await bound.execute(call("host_read", { q: index }, `call_${index}`), rehearsalCtx);
      expect(outcome).toMatchObject({ status: "ok" });
    }
    expect(tools.executions).toHaveLength(30);
  });

  it("rehearsal reads never spend the subject's window: a chat read right after still runs", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: demoPolicy,
      breakers: { maxCallsPerMinute: 2 },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    for (let index = 0; index < 5; index += 1) {
      expect(await bound.execute(call("host_read", { q: index }, `call_r${index}`), rehearsalCtx))
        .toMatchObject({ status: "ok" });
    }
    const chat = await bound.execute(call("host_read", { q: "live" }, "call_chat"), context());
    expect(chat).toMatchObject({ status: "ok" });
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
  });

  it("a window genuinely tripped by live traffic still blocks the rehearsal read honestly", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: demoPolicy,
      breakers: { maxCallsPerMinute: 1 },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    expect(await bound.execute(call("host_read", { q: 1 }, "call_live1"), context()))
      .toMatchObject({ status: "ok" });
    expect(await bound.execute(call("host_read", { q: 2 }, "call_live2"), context()))
      .toMatchObject({ status: "pending-approval" });
    const rehearsed = await bound.execute(call("host_read", { q: 3 }, "call_rh"), rehearsalCtx);
    expect(rehearsed).toMatchObject({
      status: "blocked",
      reason: "call-rate limit reached during rehearsal",
    });
    expect(tools.executions).toHaveLength(1);
  });

  it("resolves risk exactly once per rehearsal call — the gate's verdict IS the decision's", async () => {
    let resolutions = 0;
    const guard = createGuard({
      store: createMemoryStore(),
      policy: demoPolicy,
      resolveRisk: () => {
        resolutions += 1;
        return resolutions === 1 ? "read" : "write";
      },
    });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_read", { q: 1 }), rehearsalCtx);
    expect(resolutions).toBe(1);
    expect(outcome).toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("chat and automation venues are untouched: a write still parks", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_write", { v: 1 }), context());
    expect(outcome).toMatchObject({ status: "pending-approval" });
    expect(await guard.approvals.pending(alice)).toHaveLength(1);
  });
});
