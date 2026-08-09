/**
 * What a biller reads after a turn that hired — asserted over the ACTUAL audit
 * rows the guard received, from a real `vendo()` turn through the real runtime.
 *
 * The seam is the point: the harness decides what the `usage` event carries and
 * the runtime decides which rows exist, so a suite that stubbed either half
 * could never catch them disagreeing — and they did. The harness folded the
 * hires into the turn's usage AND reported each hire, so the runtime wrote both
 * a run row containing the hires and a row per hire, and a host summing rows
 * paid for every hire twice.
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

/** Every usage figure this turn wrote anywhere, one entry per row — which is
 *  exactly how a host bills: sum the rows. */
const usagesOf = (events: AuditEvent[]): RowUsage[] =>
  events
    .filter((event) => event.kind === "run")
    .flatMap((event) => {
      const detail = event.detail as { usage?: RowUsage; subagent?: { usage?: RowUsage } };
      return [detail.usage, detail.subagent?.usage].filter((usage): usage is RowUsage => usage !== undefined);
    });

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

describe("subagent spend lands in the ledger exactly once", () => {
  it("counts the whole turn's tokens once across the rows, not once per row that mentions them", async () => {
    const { guard } = await turnThatHires();
    const usages = usagesOf(guard.events);
    const total = (field: keyof RowUsage) =>
      usages.reduce((sum, usage) => sum + ((usage[field] as number | undefined) ?? 0), 0);

    // What the provider actually charged for: the resident's steps plus the
    // hire's. Summing the rows has to land on exactly that.
    expect(total("inputTokens")).toBe(RESIDENT.inputTokens.total + HIRE.inputTokens.total);
    expect(total("outputTokens")).toBe(RESIDENT.outputTokens.total + HIRE.outputTokens.total);
    expect(total("cacheReadTokens")).toBe(RESIDENT.inputTokens.cacheRead + HIRE.inputTokens.cacheRead);
    expect(total("cacheWriteTokens")).toBe(RESIDENT.inputTokens.cacheWrite + HIRE.inputTokens.cacheWrite);
  });

  it("gives the run row the resident loop alone, cache split included", async () => {
    const { guard } = await turnThatHires();
    const run = guard.events.find(
      (event) => event.kind === "run" && (event.detail as { usage?: unknown }).usage !== undefined,
    );

    expect((run!.detail as { usage: RowUsage }).usage).toMatchObject({
      inputTokens: RESIDENT.inputTokens.total,
      outputTokens: RESIDENT.outputTokens.total,
      cacheReadTokens: RESIDENT.inputTokens.cacheRead,
      cacheWriteTokens: RESIDENT.inputTokens.cacheWrite,
    });
  });

  it("gives the hire's row the hire's full usage, so its figures are priceable on their own", async () => {
    const { guard } = await turnThatHires();
    const hire = guard.events.find(
      (event) => event.kind === "run" && (event.detail as { subagent?: unknown }).subagent !== undefined,
    );

    expect((hire!.detail as { subagent: { usage: RowUsage } }).subagent.usage).toMatchObject({
      inputTokens: HIRE.inputTokens.total,
      outputTokens: HIRE.outputTokens.total,
      cacheReadTokens: HIRE.inputTokens.cacheRead,
      cacheWriteTokens: HIRE.inputTokens.cacheWrite,
    });
  });
});

describe("a usage row names the model that spent it", () => {
  it("carries the resolved model id, so a row prices without guessing the seat", async () => {
    const { guard, modelId } = await turnThatHires();
    const usages = usagesOf(guard.events);

    expect(usages).not.toHaveLength(0);
    expect(usages.every((usage) => usage.model === modelId)).toBe(true);
  });
});
