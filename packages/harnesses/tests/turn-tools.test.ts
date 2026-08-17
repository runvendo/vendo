/**
 * Build contract §1.1 (the three-status surface a harness sees) and §1.4
 * (approvals wait or fail — they never suspend a run).
 */
import type { Harness, ToolOutcome, ToolRegistry } from "@vendoai/core";
import { CAPABILITY_MISS_TOOL_NAME, type CapabilityMissReporter } from "../src/capability-miss.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnTools, type MirrorEvent } from "../src/turn-tools.js";
import { boundRegistry, ctx, readTool, testGuard } from "../src/test-doubles.test-util.js";

function harness(options: {
  registry: ToolRegistry;
  guard: ReturnType<typeof testGuard>;
  interactive?: boolean;
  approvalWaitMs?: number;
  capabilityMiss?: CapabilityMissReporter;
  toolSurface?: Harness["toolSurface"];
}) {
  const mirrored: MirrorEvent[] = [];
  const tools = createTurnTools({
    registry: options.registry,
    guard: options.guard,
    ctx: ctx(),
    interactive: options.interactive ?? true,
    mirror: (event) => mirrored.push(event),
    ...(options.capabilityMiss === undefined ? {} : { capabilityMiss: options.capabilityMiss }),
    ...(options.toolSurface === undefined ? {} : { toolSurface: options.toolSurface }),
    ...(options.approvalWaitMs === undefined ? {} : { approvalWaitMs: options.approvalWaitMs }),
  });
  return { tools, mirrored };
}

/** The reporter's SHAPE — what the runtime hands over after building the
 *  detector, without a config to wire. */
function reporterDouble(calls: unknown[] = []): CapabilityMissReporter {
  return {
    listing: {
      name: CAPABILITY_MISS_TOOL_NAME,
      title: "Report that this cannot be done",
      description: "the honest-refusal reporter",
      risk: "read",
    },
    execute: async (args) => {
      calls.push(args);
      return { status: "ok", output: { reported: true } };
    },
  };
}

describe("turn.tools.list", () => {
  it("returns the equipped tools, titling untitled descriptors by name", async () => {
    const guard = testGuard();
    const registry = boundRegistry(
      {
        maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => [] },
        maple_pay: {
          descriptor: { ...readTool("maple_pay", "destructive"), title: "Send a payment" },
          execute: () => ({ sent: true }),
        },
      },
      guard,
    );
    const { tools } = harness({ registry, guard });
    // `inputSchema` joined the listing with contract §1.1's amendment
    // 2026-07-30: an in-process harness has to hand its model real argument
    // schemas, so the listing carries the descriptor's verbatim.
    const schema = { type: "object", properties: {}, additionalProperties: true };
    await expect(tools.list()).resolves.toEqual([
      {
        name: "maple_invoices_list",
        title: "maple_invoices_list",
        description: "the maple_invoices_list tool",
        risk: "read",
        inputSchema: schema,
      },
      {
        name: "maple_pay",
        title: "Send a payment",
        description: "the maple_pay tool",
        risk: "destructive",
        inputSchema: schema,
      },
    ]);
  });

  // D5 (2026-08-03): a declared result shape rides the listing so the model
  // knows a query's fields before calling it. Optional end to end — a tool
  // whose host declared none lists exactly as before.
  it("carries the descriptor's outputSchema when it has one", async () => {
    const outputSchema = { type: "object", properties: { invoices: { type: "array" } } };
    const guard = testGuard();
    const registry = boundRegistry(
      {
        maple_invoices_list: {
          descriptor: { ...readTool("maple_invoices_list"), outputSchema },
          execute: () => [],
        },
        maple_pay: { descriptor: readTool("maple_pay", "destructive"), execute: () => ({ sent: true }) },
      },
      guard,
    );
    const { tools } = harness({ registry, guard });

    const [declared, undeclared] = await tools.list();
    expect(declared?.outputSchema).toEqual(outputSchema);
    expect(undeclared).not.toHaveProperty("outputSchema");
  });
});

/** Contract §1, amendment 2026-08-03: the harness's own say over the surface —
 *  withhold-only since the de-brain refactor (loadout curation is the brain's). */
describe("turn.tools — Harness.toolSurface", () => {
  const surfaceRig = (toolSurface?: Harness["toolSurface"]) => {
    const guard = testGuard();
    const registry = boundRegistry(
      {
        maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => [] },
        maple_reports_read: { descriptor: readTool("maple_reports_read"), execute: () => [] },
        vendo_make: { descriptor: readTool("vendo_make", "write"), execute: () => ({}) },
      },
      guard,
    );
    return harness({ registry, guard, ...(toolSurface === undefined ? {} : { toolSurface }) });
  };

  it("no toolSurface: list() is the FULL projected surface — curation is the brain's now", async () => {
    const { tools } = surfaceRig();
    const names = (await tools.list()).map((entry) => entry.name);
    expect(names).toContain("maple_invoices_list");
    expect(names).toContain("maple_reports_read");
    expect(names).toContain("vendo_make");
  });

  it("withhold: the name is off the listing and answers not-found on call", async () => {
    const { tools } = surfaceRig({ withhold: ["vendo_make"] });
    const names = (await tools.list()).map((entry) => entry.name);
    expect(names).not.toContain("vendo_make");
    expect(names).toContain("maple_invoices_list");
    await expect(tools.call("vendo_make", { request: "a dashboard" })).resolves.toEqual({
      status: "error",
      error: { code: "not-found", message: "Unknown tool: vendo_make" },
    });
  });
});

/** The honest-refusal rail: the reporter the runtime hands over is listed and
 *  dispatched here, never through the guard — reporting spends no authority. */
describe("turn.tools — the capability-miss reporter", () => {
  const rig = (calls: unknown[] = []) => {
    const guard = testGuard();
    const registry = boundRegistry(
      { maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => [] } },
      guard,
    );
    return { ...harness({ registry, guard, capabilityMiss: reporterDouble(calls) }), registry, guard };
  };

  it("rides the listing beside the projected tools", async () => {
    const { tools } = rig();
    const names = (await tools.list()).map((entry) => entry.name);
    expect(names).toContain("maple_invoices_list");
    expect(names).toContain(CAPABILITY_MISS_TOOL_NAME);
  });

  it("dispatches a call to the reporter — mirrored, and never through the guard", async () => {
    const calls: unknown[] = [];
    const { tools, mirrored, registry, guard } = rig(calls);
    const result = await tools.call(CAPABILITY_MISS_TOOL_NAME, { kind: "no-matching-tool", toolsConsidered: [] });
    expect(result).toEqual({ status: "ok", output: { reported: true } });
    expect(calls).toHaveLength(1);
    // Mirrored like any call; no registry execution, no guard consult.
    expect(mirrored.map((event) => event.kind)).toEqual(["call", "result"]);
    expect(registry.invocations[CAPABILITY_MISS_TOOL_NAME]).toBeUndefined();
    expect(guard.events.filter((event) => event.kind === "tool-call")).toEqual([]);
  });

  it("unwired, the name answers not-found like any tool this turn has not got", async () => {
    const guard = testGuard();
    const registry = boundRegistry({}, guard);
    const { tools } = harness({ registry, guard });
    const result = await tools.call(CAPABILITY_MISS_TOOL_NAME, { kind: "no-matching-tool", toolsConsidered: [] });
    expect(result.status).toBe("error");
  });
});

describe("turn.tools.call — §1.1 outcome mapping", () => {
  it("maps ok through with its output", async () => {
    const guard = testGuard();
    const registry = boundRegistry(
      { look: { descriptor: readTool("look"), execute: () => ({ found: 2 }) } },
      guard,
    );
    const { tools } = harness({ registry, guard });
    await expect(tools.call("look", {})).resolves.toEqual({ status: "ok", output: { found: 2 } });
  });

  it("maps blocked → denied, carrying the reason and no needs", async () => {
    const guard = testGuard({ look: "block" });
    const registry = boundRegistry({ look: { descriptor: readTool("look"), execute: () => 1 } }, guard);
    const { tools } = harness({ registry, guard });
    const result = await tools.call("look", {});
    expect(result).toEqual({ status: "denied", reason: "blocked" });
  });

  it("maps connect-required → denied{needs:connect} naming the toolkit", async () => {
    const guard = testGuard();
    const registry: ToolRegistry = {
      descriptors: async () => [readTool("gmail_send", "write")],
      execute: async (): Promise<ToolOutcome> => ({
        status: "connect-required",
        connect: { connector: "composio", toolkit: "gmail", message: "Connect Gmail first." },
      }),
    };
    const { tools } = harness({ registry, guard });
    const result = await tools.call("gmail_send", {});
    expect(result).toEqual({
      status: "denied",
      reason: "Connect Gmail first.",
      needs: { kind: "connect", toolkit: "gmail" },
    });
    // The `data-vendo-connect` CARD is written by the shipped bridge onto the
    // writer, not by the mirror — proven in runtime.test.ts, where a writer exists.
  });

  it("maps error through with its code and message", async () => {
    const guard = testGuard();
    const registry = boundRegistry(
      {
        boom: {
          descriptor: readTool("boom"),
          execute: () => {
            throw new Error("nope");
          },
        },
      },
      guard,
    );
    const { tools } = harness({ registry, guard });
    await expect(tools.call("boom", {})).resolves.toEqual({
      status: "error",
      error: { code: "execution", message: "nope" },
    });
  });

  it("never throws — a registry that rejects becomes an error result", async () => {
    const guard = testGuard();
    const registry: ToolRegistry = {
      descriptors: async () => [readTool("look")],
      execute: async () => {
        throw new Error("registry exploded");
      },
    };
    const { tools } = harness({ registry, guard });
    const result = await tools.call("look", {});
    expect(result.status).toBe("error");
    // The raw internal message never reaches a harness (consumer-voice law).
    expect(JSON.stringify(result)).not.toContain("registry exploded");
  });

  it("never throws — an unknown tool name becomes an error result", async () => {
    const guard = testGuard();
    const registry = boundRegistry({ look: { descriptor: readTool("look"), execute: () => 1 } }, guard);
    const { tools } = harness({ registry, guard });
    const result = await tools.call("nope_not_a_tool", {});
    expect(result.status).toBe("error");
  });
});

describe("turn.tools.call — mirroring", () => {
  it("mirrors the call AND its result before call() resolves", async () => {
    const guard = testGuard();
    const registry = boundRegistry(
      { look: { descriptor: readTool("look"), execute: () => ({ ok: 1 }) } },
      guard,
    );
    const { tools, mirrored } = harness({ registry, guard });
    const promise = tools.call("look", { q: "x" });
    // Nothing is asserted mid-flight; the contract's guarantee is that by the
    // time the promise resolves both records already exist.
    await promise;
    expect(mirrored.map((event) => event.kind)).toEqual(["call", "result"]);
    const call = mirrored[0] as Extract<MirrorEvent, { kind: "call" }>;
    expect(call.name).toBe("look");
    expect(call.args).toEqual({ q: "x" });
    const result = mirrored[1] as Extract<MirrorEvent, { kind: "result" }>;
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(result.result).toEqual({ status: "ok", output: { ok: 1 } });
  });

  it("gives every call its own tool-call id", async () => {
    const guard = testGuard();
    const registry = boundRegistry({ look: { descriptor: readTool("look"), execute: () => 1 } }, guard);
    const { tools, mirrored } = harness({ registry, guard });
    await tools.call("look", {});
    await tools.call("look", {});
    const ids = mirrored
      .filter((event) => event.kind === "call")
      .map((event) => (event as Extract<MirrorEvent, { kind: "call" }>).toolCallId);
    expect(new Set(ids).size).toBe(2);
  });

});

describe("turn.tools.call — §1.4 approvals", () => {
  let guard: ReturnType<typeof testGuard>;
  let registry: ReturnType<typeof boundRegistry>;

  beforeEach(() => {
    guard = testGuard({ pay: "ask" });
    registry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => ({ sent: true }) } },
      guard,
    );
  });

  it("interactive=false: denies immediately with needs{approval}, no wait", async () => {
    const { tools } = harness({ registry, guard, interactive: false });
    const started = Date.now();
    const result = await tools.call("pay", { amount: 10 });
    expect(result).toEqual({
      status: "denied",
      reason: expect.any(String),
      needs: { kind: "approval", approvalId: "apr_" + (guard.pending()[0]?.call.id ?? "") },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(registry.invocations.pay).toBeUndefined();
  });

  it("interactive=true: raises the card, awaits the tap, then the call proceeds", async () => {
    const { tools } = harness({ registry, guard });
    const promise = tools.call("pay", { amount: 10 });
    // The guard has been PREVIEWED (so the card is up) before the wait begins.
    await vi.waitFor(() => expect(guard.pending()).toHaveLength(1));
    guard.decide(guard.pending()[0]!.id, true);
    await expect(promise).resolves.toEqual({ status: "ok", output: { sent: true } });
    expect(registry.invocations.pay).toBe(1);
  });

  it("interactive=true: a refusal denies the call and never executes it", async () => {
    const { tools } = harness({ registry, guard });
    const promise = tools.call("pay", { amount: 10 });
    await vi.waitFor(() => expect(guard.pending()).toHaveLength(1));
    guard.decide(guard.pending()[0]!.id, false);
    const result = await promise;
    expect(result.status).toBe("denied");
    expect((result as { needs?: unknown }).needs).toBeUndefined();
    expect(registry.invocations.pay).toBeUndefined();
  });

  it("interactive=true: the wait is bounded — a timeout denies with needs{approval}", async () => {
    const { tools } = harness({ registry, guard, approvalWaitMs: 20 });
    const result = await tools.call("pay", { amount: 10 });
    expect(result).toMatchObject({ status: "denied", needs: { kind: "approval" } });
    expect(registry.invocations.pay).toBeUndefined();
  });

  it("a decision that lands before the wait begins is not lost", async () => {
    // The tap is delivered synchronously from inside the guard consult itself —
    // strictly before call() gets a chance to await the waiter. Subscribing only
    // after the preview returned would drop it and hang until the timeout.
    const racingGuard = testGuard({ pay: "ask" });
    const realCheck = racingGuard.check.bind(racingGuard);
    let decided = false;
    racingGuard.check = async (call, descriptor, runCtx) => {
      const decision = await realCheck(call, descriptor, runCtx);
      if (decision.action === "ask" && !decided) {
        decided = true;
        racingGuard.decide(decision.approval.id, true);
      }
      return decision;
    };
    const racingRegistry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => ({ sent: true }) } },
      racingGuard,
    );
    const { tools } = harness({ registry: racingRegistry, guard: racingGuard, approvalWaitMs: 50 });
    await expect(tools.call("pay", {})).resolves.toEqual({ status: "ok", output: { sent: true } });
  });

  it("interactive=true: a timeout settles as expired for the screen, denied only for the model", async () => {
    const { tools, mirrored } = harness({ registry, guard, approvalWaitMs: 20 });
    const result = await tools.call("pay", { amount: 10 });
    // The model reads the same denial it always did (parity H1 rests on it)…
    expect(result).toMatchObject({ status: "denied", needs: { kind: "approval" } });
    // …but the typed outcome the screen persists is NOT the person's no:
    // nobody answered, and only the cause lets the beat say so.
    const settled = mirrored.find((event) => event.kind === "result") as
      Extract<MirrorEvent, { kind: "result" }>;
    expect(settled.outcome).toMatchObject({ status: "blocked", cause: "expired" });
    expect(registry.invocations.pay).toBeUndefined();
  });

  it("interactive=true: an unresolvable approval still resolves — call() never suspends the run", async () => {
    const deafGuard = testGuard({ pay: "ask" });
    // A guard whose decisions never arrive: the frozen bound is the only exit.
    deafGuard.onApprovalDecision = () => () => undefined;
    const deafRegistry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => 1 } },
      deafGuard,
    );
    const { tools } = harness({ registry: deafRegistry, guard: deafGuard, approvalWaitMs: 15 });
    await expect(tools.call("pay", {})).resolves.toMatchObject({ status: "denied" });
  });
});
