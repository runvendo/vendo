import {
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolRegistry,
  VENDO_APP_FORMAT,
} from "@vendoai/core";
import type {
  AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

/**
 * A READ through `apps.call` takes the QUERY arm.
 *
 * `apps.call` is the only door a code-land app (`@vendoai/ui/kit`'s `useToolQuery`)
 * has, and it used to hand every call to `caller.call` — the arm with a random
 * uuid per invocation. A query's identity is (app, tool, args), and
 * `callQuery` derives the call id from exactly that triple (call.ts's
 * `queryCallId`) BECAUSE the guard's approved replay pins the call id: with a
 * fresh uuid, an ungraded read that parks on an approval could never be
 * satisfied — approve, refetch, new id, park again, forever.
 *
 * The discriminator is the tool's own authored `risk` grade, which is the
 * server's existing classification of what a call does. A read-graded call is a
 * query; everything else keeps the action arm, because two identical mutations
 * are two separate acts and each has to earn its own approval.
 */

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const app = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Reader",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Reader" } }],
  },
});

const descriptor = (name: string, risk: ToolDescriptor["risk"]): ToolDescriptor => ({
  name,
  description: `${risk} tool`,
  inputSchema: { type: "object", properties: {} },
  risk,
});

const DESCRIPTORS = [
  descriptor("host_listSpending", "read"),
  descriptor("host_payBill", "write"),
];

/** Records every call id the registry is asked to execute. */
const recordingTools = (calls: ToolCall[]): ToolRegistry => ({
  async descriptors() {
    return DESCRIPTORS;
  },
  async execute(call) {
    calls.push(call);
    return { status: "ok", output: { echoed: call.args } };
  },
});

const setup = (tools: ToolRegistry) => {
  const store = memoryStore();
  const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
  return { store, runtime };
};

describe("a read-graded call through apps.call takes the derived-id query arm", () => {
  it("gives a read the SAME call id every time, so an approved read's refetch is the same call", async () => {
    const calls: ToolCall[] = [];
    const { store, runtime } = setup(recordingTools(calls));
    await seedAppRow(store, app("app_read"), "user_ada");
    const ctx = context("user_ada");

    await runtime.call("app_read", "host_listSpending", { month: "2026-08" }, ctx);
    await runtime.call("app_read", "host_listSpending", { month: "2026-08" }, ctx);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.id).toBe(calls[1]?.id);
    // the derived shape, not a uuid — call.ts's queryCallId
    expect(calls[0]?.id).toMatch(/^call_q_[0-9a-f]{32}$/);
  });

  it("keys a read's id to (app, tool, args), so different args are different calls", async () => {
    const calls: ToolCall[] = [];
    const { store, runtime } = setup(recordingTools(calls));
    await seedAppRow(store, app("app_read"), "user_ada");
    await seedAppRow(store, app("app_other"), "user_ada");
    const ctx = context("user_ada");

    await runtime.call("app_read", "host_listSpending", { month: "2026-08" }, ctx);
    await runtime.call("app_read", "host_listSpending", { month: "2026-09" }, ctx);
    await runtime.call("app_other", "host_listSpending", { month: "2026-08" }, ctx);

    const ids = calls.map((call) => call.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps a WRITE on the action arm: two identical mutations are two separate acts", async () => {
    const calls: ToolCall[] = [];
    const { store, runtime } = setup(recordingTools(calls));
    await seedAppRow(store, app("app_write"), "user_ada");
    const ctx = context("user_ada");

    await runtime.call("app_write", "host_payBill", { billId: "b_1" }, ctx);
    await runtime.call("app_write", "host_payBill", { billId: "b_1" }, ctx);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
    expect(calls[0]?.id).not.toMatch(/^call_q_/);
  });

  it("an ungraded tool keeps the action arm — only an authored read is a query", async () => {
    const calls: ToolCall[] = [];
    const tools: ToolRegistry = {
      async descriptors() {
        return [descriptor("host_mystery", "ungraded")];
      },
      async execute(call) {
        calls.push(call);
        return { status: "ok", output: null };
      },
    };
    const { store, runtime } = setup(tools);
    await seedAppRow(store, app("app_ungraded"), "user_ada");
    const ctx = context("user_ada");

    await runtime.call("app_ungraded", "host_mystery", {}, ctx);
    await runtime.call("app_ungraded", "host_mystery", {}, ctx);

    expect(calls[0]?.id).not.toBe(calls[1]?.id);
  });

  it("APPROVE then REFETCH satisfies the read instead of parking it a second time", async () => {
    // The guard, in the only respect this test is about: an ungraded read parks
    // once, the owner's yes pins THAT call id, and a call arriving with the
    // pinned id executes. A refetch that changed its id would park forever —
    // the bug this arm exists to prevent.
    const parked: string[] = [];
    let approved: string | undefined;
    const tools: ToolRegistry = {
      async descriptors() {
        return [descriptor("host_listSpending", "read")];
      },
      async execute(call) {
        if (call.id === approved) return { status: "ok", output: [{ merchant: "Blue Bottle" }] };
        parked.push(call.id);
        approved ??= call.id; // the owner approves the call they were shown
        return { status: "pending-approval", approvalId: "apr_1" };
      },
    };
    const { store, runtime } = setup(tools);
    await seedAppRow(store, app("app_read"), "user_ada");
    const ctx = context("user_ada");

    const first = await runtime.call("app_read", "host_listSpending", { month: "2026-08" }, ctx);
    expect(first.status).toBe("pending-approval");

    const refetch = await runtime.call("app_read", "host_listSpending", { month: "2026-08" }, ctx);

    expect(refetch).toEqual({ status: "ok", output: [{ merchant: "Blue Bottle" }] });
    // parked exactly once: the yes landed on the call the refetch actually made
    expect(parked).toHaveLength(1);
  });
});
