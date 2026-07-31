import { isRehearsalSimulation } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice, call, context, descriptor, FixtureTools } from "./fixtures/tools.js";

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

  it("never executes a write: returns the simulated card with the resolved args", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const args = { to: "user@example.com", body: "Balance is $1,500" };
    const outcome = await guard.bind(tools).execute(call("host_write", args, "call_w"), rehearsalCtx);
    expect(outcome.status).toBe("ok");
    const output = (outcome as { status: "ok"; output: unknown }).output;
    expect(isRehearsalSimulation(output)).toBe(true);
    expect(output).toEqual({
      rehearsalSimulated: true,
      tool: "host_write",
      risk: "write",
      args,
    });
    // The registry was never reached: nothing executed.
    expect(tools.executions).toHaveLength(0);
  });

  it("never executes a destructive call either", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const outcome = await guard.bind(tools).execute(call("host_destructive", { id: "x" }), rehearsalCtx);
    expect(outcome.status).toBe("ok");
    expect(isRehearsalSimulation((outcome as { status: "ok"; output: unknown }).output)).toBe(true);
    expect(tools.executions).toHaveLength(0);
  });

  it("parks NO approvals for writes — the ask-on-write policy never gets to ask", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    await guard.bind(tools).execute(call("host_write", { v: 1 }), rehearsalCtx);
    await guard.bind(tools).execute(call("host_destructive", { v: 2 }, "call_2"), rehearsalCtx);
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
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

  it("a full-length rehearsal (62 reads) never trips the call-rate breaker on itself", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: demoPolicy });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    for (let index = 0; index < 62; index += 1) {
      const outcome = await bound.execute(call("host_read", { q: index }, `call_${index}`), rehearsalCtx);
      expect(outcome).toMatchObject({ status: "ok" });
    }
    expect(tools.executions).toHaveLength(62);
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
