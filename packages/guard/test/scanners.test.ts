import type { AuditEvent } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice, call, context, descriptor, FixtureTools } from "./fixtures/tools.js";

function detail(event: AuditEvent): string {
  return JSON.stringify(event.detail ?? {});
}

describe("input and output scanners", () => {
  it("blocks input with joined findings before execution and audits the finding", async () => {
    const scan = vi.fn(async () => ({ verdict: "block" as const, findings: ["prompt injection", "secret"] }));
    const guard = createGuard({
      store: createMemoryStore(),
      scanners: [{ name: "input-guard", on: "input", scan }],
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const toolCall = call("host_write", { z: 1, a: 2 }, "scan_input");

    await expect(bound.execute(toolCall, context())).resolves.toEqual({
      status: "blocked",
      reason: "prompt injection; secret",
    });
    expect(tools.executions).toHaveLength(0);
    expect(scan).toHaveBeenCalledWith({ text: '{"a":2,"z":1}', call: toolCall, ctx: context() });
    const { events } = await guard.audit.query({ principal: alice, kind: "policy-decision" });
    expect(events.some((event) => detail(event).includes("prompt injection"))).toBe(true);
  });

  it("records input flags and scanner throws but continues", async () => {
    const outputOnly = vi.fn(async () => ({ verdict: "block" as const }));
    const guard = createGuard({
      store: createMemoryStore(),
      scanners: [
        { name: "flagger", on: "input", scan: async () => ({ verdict: "flag", findings: ["suspicious"] }) },
        {
          name: "broken-integration",
          on: "input",
          scan: async () => {
            throw new Error("scanner offline");
          },
        },
        { name: "output-only", on: "output", scan: outputOnly },
      ],
    });
    const decision = await guard.check(call("host_read"), descriptor("read"), context());
    expect(decision).toMatchObject({ action: "run", decidedBy: "default" });
    expect(outputOnly).not.toHaveBeenCalled();
    const { events } = await guard.audit.query({ principal: alice, kind: "policy-decision" });
    expect(events.some((event) => detail(event).includes("suspicious"))).toBe(true);
    expect(events.some((event) => detail(event).includes("broken-integration") || detail(event).includes("scanner offline"))).toBe(true);
  });

  it("replaces an ok output when an output scanner blocks", async () => {
    const inputOnly = vi.fn(async () => ({ verdict: "ok" as const }));
    const output = vi.fn(async () => ({ verdict: "block" as const, findings: ["PII exposed"] }));
    const guard = createGuard({
      store: createMemoryStore(),
      scanners: [
        { name: "input-only", on: "input", scan: inputOnly },
        { name: "output-pii", on: "output", scan: output },
      ],
    });
    const tools = new FixtureTools();
    tools.setOutcome("host_read", { status: "ok", output: { ssn: "000-00-0000" } });
    const result = await guard.bind(tools).execute(call("host_read", {}, "scan_output"), context());

    expect(result).toEqual({ status: "blocked", reason: "PII exposed" });
    expect(inputOnly).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith({
      text: '{"ssn":"000-00-0000"}',
      call: call("host_read", {}, "scan_output"),
      ctx: context(),
    });
  });

  it("keeps output on flag or throw and never scans non-ok outcomes", async () => {
    const flag = vi.fn(async () => ({ verdict: "flag" as const, findings: ["review later"] }));
    const broken = vi.fn(async () => {
      throw new Error("output scanner offline");
    });
    const guard = createGuard({
      store: createMemoryStore(),
      scanners: [
        { name: "flag", on: "output", scan: flag },
        { name: "broken", on: "output", scan: broken },
      ],
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    await expect(bound.execute(call("host_read", {}, "flag_output"), context())).resolves.toMatchObject({ status: "ok" });
    expect(flag).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(1);

    tools.setOutcome("host_read", { status: "error", error: { code: "upstream", message: "failed" } });
    await expect(bound.execute(call("host_read", {}, "error_output"), context())).resolves.toMatchObject({ status: "error" });
    expect(flag).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(1);
  });
});
