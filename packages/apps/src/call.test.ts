import type { AppDocument, RunContext, ToolCall, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

// execution-v2 Wave 1.5 — the v1 MachineSessions fn: path is deleted. Until
// the in-runtime v2 fn path lands (fn/schedules lane), an fn: ref settles as a
// CONTAINED not-implemented outcome; host-tool refs ride the guard-bound
// registry unchanged. The wire-level v2 fn path (POST /apps/:appId/fn/:name →
// box door) is covered by the wire suites.

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const app = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Caller",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Caller" } }],
  },
});

const setup = (tools?: ToolRegistry) => {
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools: tools ?? {
      async descriptors() { return []; },
      async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
    },
    catalog: [],
  });
  return { store, runtime };
};

describe("app calls through createApps", () => {
  it("routes a host-tool ref to the guard-bound registry with app venue and app id", async () => {
    const calls: { call: ToolCall; ctx: RunContext }[] = [];
    const tools: ToolRegistry = {
      async descriptors() { return []; },
      async execute(call, runCtx) {
        calls.push({ call, ctx: runCtx });
        return { status: "ok", output: { echoed: call.args } };
      },
    };
    const { store, runtime } = setup(tools);
    await seedAppRow(store, app("app_host"), "user_ada");

    const outcome = await runtime.call("app_host", "host_invoices_list", { page: 1 }, context("user_ada"));

    expect(outcome).toEqual({ status: "ok", output: { echoed: { page: 1 } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call.tool).toBe("host_invoices_list");
    expect(calls[0]?.ctx.venue).toBe("app");
    expect(calls[0]?.ctx.appId).toBe("app_host");
  });

  it("settles an fn: ref on a machine-less app as a contained outcome, never a throw", async () => {
    // fn: refs on a MACHINE-BEARING app ride the v2 box door (fn.ts suites);
    // this pins the base caller's fallthrough for an app that never graduated.
    const { store, runtime } = setup();
    await seedAppRow(store, app("app_fn"), "user_ada");

    const outcome = await runtime.call("app_fn", "fn:send_invoice", {}, context("user_ada"));

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("unreachable");
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.message).toContain("requires a machine");
  });

  it("rejects a malformed fn name as a validation outcome", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, app("app_bad_fn"), "user_ada");

    const outcome = await runtime.call("app_bad_fn", "fn:bad name!", {}, context("user_ada"));

    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });

  it("scopes calls to the owner: a foreign principal sees not-found", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, app("app_owned"), "user_ada");

    await expect(
      runtime.call("app_owned", "host_anything", {}, context("user_bob")),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});
