/**
 * What a biller reads after a turn that hired — asserted over the ACTUAL audit
 * rows the guard received, from a real `vendo()` turn through the real runtime.
 *
 * The seam is the point: the harness decides what its `usage` events carry and
 * the runtime decides what the row holds, so a suite that stubbed either half
 * could never catch them disagreeing. Since the de-brain refactor there is ONE
 * run row per turn and its `usage` is the turn's WHOLE spend: the resident's
 * own figure and each hire's ride separate `usage` events (they partition the
 * turn), and the runtime's `addUsage` folds them — the per-hire receipt rows
 * are gone (Option 1, 2026-08-09).
 */
import type { AuditEvent, ThreadId } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { vendo } from "../../src/vendo/vendo.js";
import { createHarnessRuntime } from "../../src/runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  scriptedModel,
  seats,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  textTurn,
  toolCallTurn,
  userMessage,
} from "../../src/test-doubles.test-util.js";

const THREAD = "thr_ledger" as ThreadId;

/** The resident's own step. Split across the cache so the row's cache figures
 *  can be checked against the loop that actually spent them. */
const RESIDENT = {
  inputTokens: { total: 1_000, noCache: 600, cacheRead: 300, cacheWrite: 100 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
} as const;

/** The hire — the bulk of a build turn's inference, and its own cache split. */
const HIRE = {
  inputTokens: { total: 90_000, noCache: 60_000, cacheRead: 25_000, cacheWrite: 5_000 },
  outputTokens: { total: 4_000, text: 4_000, reasoning: 0 },
} as const;

interface RowUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

/** A turn whose resident hires one specialist and then answers. */
async function turnThatHires() {
  const model = scriptedModel([
    toolCallTurn("hire_subagent", { instructions: "build the invoices app" }),
    textTurn("did the big job", HIRE),
    textTurn("All done.", RESIDENT),
  ]);
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
  });
  await readSse(await runtime.run({
    harness: vendo(),
    threadId: THREAD,
    messages: [userMessage("m1", "build me an invoices app")],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: seats(model),
    interactive: true,
  }));
  return { guard, modelId: (model as unknown as { modelId: string }).modelId };
}

const runRows = (events: AuditEvent[]): AuditEvent[] =>
  events.filter((event) => event.kind === "run");

describe("a turn that hires lands in the ledger as ONE row, priced whole", () => {
  it("writes exactly one run row, whose usage is the SUM of the resident and its helpers", async () => {
    const { guard } = await turnThatHires();
    const rows = runRows(guard.events);
    expect(rows).toHaveLength(1);

    // The resident's `finish` figure and the hire's own `usage` event were
    // separate events partitioning the turn; the row is their sum — what the
    // provider actually charged for, counted once.
    const usage = (rows[0]!.detail as { usage: RowUsage }).usage;
    expect(usage).toMatchObject({
      inputTokens: RESIDENT.inputTokens.total + HIRE.inputTokens.total,
      outputTokens: RESIDENT.outputTokens.total + HIRE.outputTokens.total,
      cacheReadTokens: RESIDENT.inputTokens.cacheRead + HIRE.inputTokens.cacheRead,
      cacheWriteTokens: RESIDENT.inputTokens.cacheWrite + HIRE.inputTokens.cacheWrite,
    });
  });

  it("writes no per-hire row: staffing is the brain's strategy, and the meter reads tokens", async () => {
    const { guard } = await turnThatHires();
    const mentioned = guard.events.filter(
      (event) => event.kind === "run" && JSON.stringify(event.detail).includes("subagent"),
    );
    expect(mentioned).toEqual([]);
  });

  it("names the model that spent it, so the row prices without guessing the seat", async () => {
    const { guard, modelId } = await turnThatHires();
    const usage = (runRows(guard.events)[0]!.detail as { usage: RowUsage }).usage;
    expect(usage.model).toBe(modelId);
  });
});
