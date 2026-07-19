import { VENDO_APP_FORMAT, VendoError, type AppDocument, type RunContext, type ToolOutcome } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import type { AppCaller } from "./call.js";
import { createFnCaller } from "./fn.js";
import type { SandboxMachine } from "./sandbox.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_fn",
};

const machineApp = (id = "app_fn"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Fn app",
  machine: { snapshotRef: "fake-v2:snap_1", provisionedAt: "2026-07-19T00:00:00.000Z" },
});

const treeApp = (id = "app_tree"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Tree app",
});

interface BoxAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** A wake seam whose machine dispatches requests to the given handler. */
const boxWake = (handler: (request: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}) => BoxAnswer) => {
  const seen: Array<{ method: string; path: string; headers?: Record<string, string>; body?: string }> = [];
  const machine: SandboxMachine = {
    id: "fake_fn_box",
    async request(request) {
      seen.push({
        method: request.method,
        path: request.path,
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined
          ? {}
          : { body: typeof request.body === "string" ? request.body : decoder.decode(request.body) }),
      });
      const answer = handler(request);
      return {
        status: answer.status,
        headers: answer.headers ?? {},
        body: encoder.encode(answer.body ?? ""),
      };
    },
    async snapshot() { return "fake-v2:snap_next"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return { seen, wake: vi.fn(async () => machine) };
};

describe("createFnCaller (execution-v2 fn resolution over the box door)", () => {
  it("POSTs /fn/<name> with the {args} envelope and binds {result} like a tool outcome", async () => {
    const { seen, wake } = boxWake(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { total: 42 } }),
    }));
    const fn = createFnCaller({ wake });
    const outcome = await fn.callFn(machineApp(), "total", { rows: [1, 41] }, ctx);
    expect(outcome).toEqual({ status: "ok", output: { total: 42 } });
    expect(seen).toEqual([{
      method: "POST",
      path: "/fn/total",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { rows: [1, 41] } }),
    }]);
  });

  it("relays a structured box error envelope as a contained error outcome", async () => {
    const { wake } = boxWake(() => ({
      status: 422,
      body: JSON.stringify({ error: { code: "invoice-missing", message: "no such invoice" } }),
    }));
    const outcome = await createFnCaller({ wake }).callFn(machineApp(), "chase", {}, ctx);
    expect(outcome).toEqual({
      status: "error",
      error: { code: "invoice-missing", message: "no such invoice" },
    });
  });

  it("contains an unstructured box failure as a machine error", async () => {
    const { wake } = boxWake(() => ({ status: 500, body: "boom" }));
    const outcome = await createFnCaller({ wake }).callFn(machineApp(), "chase", {}, ctx);
    expect(outcome).toMatchObject({ status: "error", error: { code: "machine" } });
  });

  it("rejects a success body that is not a {result} envelope (the machine never draws)", async () => {
    for (const body of ["not json", JSON.stringify([1]), JSON.stringify({}), JSON.stringify({ ui: {} }), JSON.stringify({ result: 1, ui: {} })]) {
      const { wake } = boxWake(() => ({ status: 200, body }));
      const outcome = await createFnCaller({ wake }).callFn(machineApp(), "report", {}, ctx);
      expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    }
  });

  it("rejects an invalid fn name without waking the machine", async () => {
    const { wake } = boxWake(() => ({ status: 200 }));
    const outcome = await createFnCaller({ wake }).callFn(machineApp(), "9bad name", {}, ctx);
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(wake).not.toHaveBeenCalled();
  });

  it("contains a machine-less app as a validation error without waking", async () => {
    const { wake } = boxWake(() => ({ status: 200 }));
    const outcome = await createFnCaller({ wake }).callFn(treeApp(), "total", {}, ctx);
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(wake).not.toHaveBeenCalled();
  });

  it("contains a wake failure as an error outcome, never a thrown white box", async () => {
    const wake = vi.fn(async (): Promise<SandboxMachine> => {
      throw new VendoError("sandbox-unavailable", "sandbox execution is unavailable");
    });
    const outcome = await createFnCaller({ wake }).callFn(machineApp(), "total", {}, ctx);
    expect(outcome).toEqual({
      status: "error",
      error: { code: "sandbox-unavailable", message: "sandbox execution is unavailable" },
    });
  });

  describe("wrap(caller)", () => {
    const innerOutcome: ToolOutcome = { status: "ok", output: "inner" };
    const inner: AppCaller = {
      call: vi.fn(async () => innerOutcome),
      callFn: vi.fn(async () => innerOutcome),
      callQuery: vi.fn(async () => ({ outcome: innerOutcome, uiEnvelope: false })),
    };

    it("routes fn: refs on a machine-bearing app to the box for call and callQuery", async () => {
      const { seen, wake } = boxWake(() => ({
        status: 200,
        body: JSON.stringify({ result: { ok: true } }),
      }));
      const wrapped = createFnCaller({ wake }).wrap(inner);
      const call = await wrapped.call(machineApp(), "fn:submit", { id: "i1" }, ctx);
      const query = await wrapped.callQuery(machineApp(), "fn:report", {}, ctx);
      expect(call).toEqual({ status: "ok", output: { ok: true } });
      expect(query).toEqual({ outcome: { status: "ok", output: { ok: true } }, uiEnvelope: false });
      expect(seen.map((request) => request.path)).toEqual(["/fn/submit", "/fn/report"]);
      expect(inner.call).not.toHaveBeenCalled();
      expect(inner.callQuery).not.toHaveBeenCalled();
    });

    it("delegates host tool refs and machine-less fn: refs to the inner caller", async () => {
      const { wake } = boxWake(() => ({ status: 200, body: JSON.stringify({ result: 1 }) }));
      const wrapped = createFnCaller({ wake }).wrap(inner);
      expect(await wrapped.call(machineApp(), "host_tool", {}, ctx)).toEqual(innerOutcome);
      expect(await wrapped.call(treeApp(), "fn:total", {}, ctx)).toEqual(innerOutcome);
      expect((await wrapped.callQuery(treeApp(), "host_tool", {}, ctx)).outcome).toEqual(innerOutcome);
      expect(await wrapped.callFn(treeApp(), "total", {}, ctx)).toEqual(innerOutcome);
      expect(wake).not.toHaveBeenCalled();
    });
  });
});
