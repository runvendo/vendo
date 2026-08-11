/**
 * The `onCall` slot's isolation contract.
 *
 * Several independent watchers share this one slot on a composed turn — the
 * turn's tool counting (composition, harness-turn.ts), the away run record
 * (agents/away.ts), the capability-miss detector (this runtime). That they all
 * RUN is proven at the composition seam, in
 * `packages/vendo/tests/tool-call-hooks.seam.test.ts`, where the real
 * composition fills two of them.
 *
 * What is pinned here is the half no composed turn can stage: a watcher that
 * THROWS. A watcher is an observer, so a throw is logged and skipped — it may
 * not fail the tool call, change its outcome, or stop any other watcher, on the
 * way in or on the way out.
 */
import { setLogger, type CapabilityMissEvent, type Harness, type ThreadId, type ToolOutcome, type VendoLogEvent } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { defineHarness } from "../src/define.js";
import { memoryHarnessStateStore } from "../src/harness-state.js";
import { createHarnessRuntime } from "../src/runtime.js";
import { mergeToolCallHooks, type ToolCallHook } from "../src/tool-bridge.js";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_hooks" as ThreadId;

afterEach(() => {
  setLogger(undefined);
});

/**
 * One turn on the real runtime with `watchers` filling composition's bridge slot
 * — the shape the umbrella really passes — while the runtime adds the real
 * capability-miss detector to the same slot on top.
 */
async function runTurn(watchers: ToolCallHook, harness: Harness): Promise<{
  logs: VendoLogEvent[];
  misses: CapabilityMissEvent[];
}> {
  const logs: VendoLogEvent[] = [];
  const misses: CapabilityMissEvent[] = [];
  setLogger((event) => { logs.push(event); });
  const guard = testGuard();
  const registry = boundRegistry({
    maple_invoices_list: { descriptor: readTool("maple_invoices_list"), execute: () => ({ count: 2 }) },
    maple_ledger_export: {
      descriptor: readTool("maple_ledger_export"),
      execute: () => { throw new Error("the ledger is offline"); },
    },
  }, guard);
  const runtime = createHarnessRuntime({
    tools: registry,
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
    harnessState: memoryHarnessStateStore(),
    bridge: { onCall: watchers },
  });
  // Drained, exactly as a host route does: the turn's own cleanup only runs on
  // consumption.
  await readSse(await runtime.run({
    harness,
    threadId: THREAD,
    messages: [userMessage("m1", "export the ledger")],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
    capabilityMiss: {
      config: {
        hostId: "host_test",
        surface: async () => ({ format: "vendo/tools@1", hash: `sha256:${"a".repeat(64)}` }),
        emit: (event) => { misses.push(event); },
      },
      intent: "export the ledger",
    },
  }));
  return { logs, misses };
}

/**
 * The harness every case runs: one tool that answers, then the SAME broken tool
 * twice — the capability-miss detector's `repeated-tool-failure` trigger, which
 * it can only see through its `onCall` finisher. The reporter afterwards answers
 * `{ reported: false }` only once the detector has ALREADY fired, so `latch` is
 * that watcher saying, through its own product read path, that it survived.
 */
function caller(seen: { statuses: string[]; latch?: unknown }): Harness {
  return defineHarness({
    name: "caller",
    async *run(turn) {
      seen.statuses.push((await turn.tools.call("maple_invoices_list", {})).status);
      seen.statuses.push((await turn.tools.call("maple_ledger_export", {})).status);
      seen.statuses.push((await turn.tools.call("maple_ledger_export", {})).status);
      const report = await turn.tools.call("vendo_report_capability_miss", {
        kind: "no-matching-tool",
        toolsConsidered: ["maple_ledger_export"],
      });
      seen.latch = report.status === "ok" ? report.output : report;
      yield { type: "text", delta: "done" };
    },
  });
}

describe("a throwing onCall watcher", () => {
  it("neither fails the call nor stops the other watchers when it throws on the way in", async () => {
    const seen: { statuses: string[]; latch?: unknown } = { statuses: [] };
    const counted: string[] = [];
    const { logs } = await runTurn(
      mergeToolCallHooks(
        () => { throw new Error("watcher exploded"); },
        (call) => { counted.push(call.tool); return () => {}; },
      ),
      caller(seen),
    );

    // The calls themselves are untouched: the good one still answered, the
    // broken one still failed on its own merits.
    expect(seen.statuses).toEqual(["ok", "error", "error"]);
    // The watcher AFTER the thrower still saw every guarded call…
    expect(counted).toEqual(["maple_invoices_list", "maple_ledger_export", "maple_ledger_export"]);
    // …and so did the runtime's own, which reported on the second failure.
    expect(seen.latch).toEqual({ reported: false });
    // Skipped, never swallowed: an operator can grep for a broken watcher.
    expect(logs.map((entry) => entry.code)).toContain("harnesses.tool-call-hook-failed");
  });

  it("neither changes the outcome nor stops the other watchers when its FINISHER throws", async () => {
    const seen: { statuses: string[]; latch?: unknown } = { statuses: [] };
    const finished: Array<ToolOutcome["status"]> = [];
    const { logs } = await runTurn(
      mergeToolCallHooks(
        () => () => { throw new Error("finisher exploded"); },
        () => (outcome) => { finished.push(outcome.status); },
      ),
      caller(seen),
    );

    expect(seen.statuses).toEqual(["ok", "error", "error"]);
    // The finisher after the throwing one still received every outcome, and the
    // outcome each watcher saw is the one the harness got.
    expect(finished).toEqual(["ok", "error", "error"]);
    expect(seen.latch).toEqual({ reported: false });
    expect(logs.filter((entry) => entry.code === "harnesses.tool-call-hook-failed")).toHaveLength(3);
  });
});
