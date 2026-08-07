/**
 * Build contract §1.1 (the three-status surface a harness sees) and §1.4
 * (approvals wait or fail — they never suspend a run).
 */
import type { Harness, ToolOutcome, ToolRegistry } from "@vendoai/core";
import { CAPABILITY_MISS_TOOL_NAME } from "./capability-miss.js";
import { FIND_TOOLS_TOOL_NAME } from "./tool-search.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryRails, MetaTool } from "./discovery.js";
import { APPROVAL_WAIT_MS, createTurnTools, type MirrorEvent } from "./turn-tools.js";
import { boundRegistry, ctx, readTool, testGuard } from "./test-doubles.test-util.js";

function harness(options: {
  registry: ToolRegistry;
  guard: ReturnType<typeof testGuard>;
  interactive?: boolean;
  approvalWaitMs?: number;
  discovery?: DiscoveryRails;
  toolSurface?: Harness["toolSurface"];
}) {
  const mirrored: MirrorEvent[] = [];
  const tools = createTurnTools({
    registry: options.registry,
    guard: options.guard,
    ctx: ctx(),
    interactive: options.interactive ?? true,
    mirror: (event) => mirrored.push(event),
    ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
    ...(options.toolSurface === undefined ? {} : { toolSurface: options.toolSurface }),
    ...(options.approvalWaitMs === undefined ? {} : { approvalWaitMs: options.approvalWaitMs }),
  });
  return { tools, mirrored };
}

/** The shipped rails' SHAPE: a loadout that equips a subset, and both meta-tools
 *  as callable entries — what `createDiscoveryRails` returns, without a search
 *  provider to configure. */
function discoveryDouble(equipped: string[]): DiscoveryRails {
  const metaTool = (name: string): [string, MetaTool] => [
    name,
    {
      listing: { name, title: name, description: `the ${name} meta-tool`, risk: "read" },
      execute: async () => ({ status: "ok", output: { ran: name } }),
    },
  ];
  return {
    activeToolNames: () => equipped,
    meta: new Map([metaTool(CAPABILITY_MISS_TOOL_NAME), metaTool(FIND_TOOLS_TOOL_NAME)]),
  };
}

describe("APPROVAL_WAIT_MS", () => {
  it("is the frozen 90s from build contract §1.4", () => {
    expect(APPROVAL_WAIT_MS).toBe(90_000);
  });
});

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

/** Contract §1, amendment 2026-08-03: the harness's own say over the surface. */
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
    // The loadout equips ONE name, so anything else on the listing can only be
    // there because the loadout was skipped.
    const discovery = discoveryDouble(["maple_reports_read"]);
    return harness({ registry, guard, discovery, ...(toolSurface === undefined ? {} : { toolSurface }) });
  };

  it("no toolSurface: the loadout curates and find_tools is offered — today's behaviour", async () => {
    const { tools } = surfaceRig();
    const names = (await tools.list()).map((entry) => entry.name);
    expect(names).not.toContain("maple_invoices_list");
    expect(names).toContain("maple_reports_read");
    expect(names).toContain(FIND_TOOLS_TOOL_NAME);
    expect(names).toContain(CAPABILITY_MISS_TOOL_NAME);
  });

  it("curated:false: the loadout is skipped, find_tools is gone, the miss reporter stays", async () => {
    const { tools } = surfaceRig({ curated: false });
    const names = (await tools.list()).map((entry) => entry.name);
    // The tool the loadout hid is on the listing — that IS the uncurated surface.
    expect(names).toContain("maple_invoices_list");
    // Nothing left for search to unlock, so the meta-tool that unlocks it goes...
    expect(names).not.toContain(FIND_TOOLS_TOOL_NAME);
    // ...and the honest-refusal rail, which has nothing to do with curation, stays.
    expect(names).toContain(CAPABILITY_MISS_TOOL_NAME);
  });

  it("curated:false: calling find_tools is not-found, like any name that was never listed", async () => {
    const { tools } = surfaceRig({ curated: false });
    const result = await tools.call(FIND_TOOLS_TOOL_NAME, { query: "invoices" });
    expect(result).toEqual({
      status: "error",
      error: { code: "not-found", message: `Unknown tool: ${FIND_TOOLS_TOOL_NAME}` },
    });
  });

  it("withhold: the name is off the listing and answers not-found on call", async () => {
    const { tools } = surfaceRig({ curated: false, withhold: ["vendo_make"] });
    const names = (await tools.list()).map((entry) => entry.name);
    expect(names).not.toContain("vendo_make");
    expect(names).toContain("maple_invoices_list");
    await expect(tools.call("vendo_make", { request: "a dashboard" })).resolves.toEqual({
      status: "error",
      error: { code: "not-found", message: "Unknown tool: vendo_make" },
    });
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
