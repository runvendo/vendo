/** 07 §4 fn: steps through the REAL apps runtime against an in-process machine
 * (fn-sandbox.ts). Proves the deterministic v0 rule end to end without a live
 * key: a steps pipeline whose fn: step reaches a machine's POST /fn/<name>,
 * with the event in its args, the { result } consumed by a later host tool via
 * JSONata, and a machine { error } envelope hard-failing the run.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Json } from "@vendoai/core";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, enableAndApprove, fixtureInvoices } from "./support.js";
import { fnSandbox, type FnResponse } from "./fn-sandbox.js";

function machine(name: string, args: Json): FnResponse {
  const record = (args ?? {}) as Record<string, Json>;
  if (name === "main") {
    // 06 §4.1 success envelope: exactly one of { result } | { ui }.
    return { status: 200, body: { result: { echo: record.note ?? null, from: "machine" } } as Json };
  }
  if (name === "boom") {
    return { status: 500, body: { error: { code: "machine-broke", message: "kaboom" } } as Json };
  }
  return { status: 404, body: { error: { code: "not-found", message: `no fn ${name}` } } as Json };
}

describe("fn: steps through a real machine", () => {
  beforeEach(resetFixture);

  it("captures only the host tool on enable, feeds the machine result onward, and completes", async () => {
    const stack = await createStack({ sandbox: fnSandbox(machine) });
    try {
      const appId = "app_fn_result";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, {
        ...automationDoc({
          id: appId,
          trigger: {
            on: { kind: "host-event", event: "fn.ready" },
            run: {
              kind: "steps",
              steps: [
                { id: "main", tool: "fn:main", args: { note: "event.note" } },
                {
                  id: "record",
                  tool: "host_invoices_create",
                  args: {
                    customerId: "'cus_ada'",
                    amountCents: "1",
                    currency: "'USD'",
                    memo: "steps.main.echo & ' via ' & steps.main.from",
                  },
                },
              ],
            },
          },
        }),
        server: "fake:snap",
      });

      // fn: refs need no grant — only the host write is captured (07 §3, §4).
      const captured = await enableAndApprove(stack, appId, ctx);
      expect(captured.map((request) => request.call.tool)).toEqual(["host_invoices_create"]);

      const runIds = await stack.automations.emit("fn.ready", { note: "wave5" }, ADA);
      const runId = runIds[0];
      if (!runId) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(runId, ctx);
      expect(run?.status).toBe("ok");
      expect(run?.steps.map(({ id, tool, outcome }) => ({ id, tool, outcome }))).toEqual([
        { id: "main", tool: "fn:main", outcome: "ok" },
        { id: "record", tool: "host_invoices_create", outcome: "ok" },
      ]);
      expect((await stack.sql<{ status: string }>("SELECT status FROM vendo_runs WHERE id = $1", [runId]))[0]?.status)
        .toBe("ok");
      expect((await fixtureInvoices()).find(({ memo }) => memo === "wave5 via machine"))
        .toMatchObject({ amountCents: 1, customerId: "cus_ada" });
    } finally {
      await stack.close();
    }
  });

  it("hard-fails the run on a machine error envelope and never reaches the later step", async () => {
    const stack = await createStack({ sandbox: fnSandbox(machine) });
    try {
      const appId = "app_fn_error";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, {
        ...automationDoc({
          id: appId,
          trigger: {
            on: { kind: "host-event", event: "fn.boom" },
            run: {
              kind: "steps",
              steps: [
                { id: "boom", tool: "fn:boom", args: {} },
                {
                  id: "record",
                  tool: "host_invoices_create",
                  args: { customerId: "'cus_ada'", amountCents: "1", memo: "'should never write'" },
                },
              ],
            },
          },
        }),
        server: "fake:snap",
      });
      await enableAndApprove(stack, appId, ctx);

      const runIds = await stack.automations.emit("fn.boom", {}, ADA);
      const runId = runIds[0];
      if (!runId) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(runId, ctx);
      expect(run?.status).toBe("error");
      expect(run?.error).toMatchObject({ code: "machine-broke", message: "kaboom" });
      expect(run?.steps.map(({ id, outcome }) => ({ id, outcome }))).toEqual([{ id: "boom", outcome: "error" }]);
      expect(run?.steps.some((step) => step.id === "record")).toBe(false);
      expect((await fixtureInvoices()).some(({ memo }) => memo === "should never write")).toBe(false);
      const stored = await stack.sql<{ status: string }>("SELECT status FROM vendo_runs WHERE id = $1", [runId]);
      expect(stored[0]?.status).toBe("error");
    } finally {
      await stack.close();
    }
  });
});
