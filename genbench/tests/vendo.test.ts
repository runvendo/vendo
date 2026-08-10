/**
 * The revision seam: the artifact this driver reports and the payload it reports
 * beside it must describe the SAME save.
 *
 * A SEAM test — the real store, the real guard, the real apps runtime and the
 * real render seam decide what lands and what paints. Only the MODEL is a
 * double, so what is measured is the driver's reading of what actually happened.
 */
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Meter } from "../src/meter.js";
import { vendoDriver } from "../src/vendo.js";
import { loadWorld, type Case, type World } from "../src/world.js";

type StreamPart = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer Part>
  ? Part
  : never;

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

const saveTurn = (content: string, id: string): StreamPart[] => [
  { type: "tool-call", toolCallId: id, toolName: "save_app", input: JSON.stringify({ content }) },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
];

const stopTurn = (): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "done" },
  { type: "text-end", id: "t1" },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
];

/** A meter over a model that replays the given turns, so the loop — not a real
 *  model — decides what lands. */
function scripted(turns: StreamPart[][]): Meter {
  const remaining = turns.map((turn) => [...turn]);
  let tick = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return {
    model,
    elapsedMs: () => (tick += 1),
    totals: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }),
    usd: () => 0,
  };
}

/** One node under the root is the render seam's whole gate, so this is the
 *  smallest document that legitimately paints. */
const PAINTS = `<App name="Spending">
  <Stack>
    <Text text="This month" />
  </Stack>
</App>`;

/** Compiles clean and reports NO issues, but leaves a childless root — the
 *  compiler's degraded floor. The seam lands its bytes and paints nothing. */
const LANDS_UNPAINTED = `<App name="Spending">
</App>`;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
});

const caseFor = (id: string): Case => ({ id, lane: "screen", prompt: "Show this month's spending", pass: [] });

describe("the vendo driver reports one revision", () => {
  it("does not report an earlier revision's view beside a final save that never painted", async () => {
    const outcome = await vendoDriver().run({
      world,
      testCase: caseFor("stale-view"),
      meter: scripted([saveTurn(PAINTS, "c1"), saveTurn(LANDS_UNPAINTED, "c2"), stopTurn()]),
    });

    // The earlier save really did paint — without this the case proves nothing.
    expect(outcome.snapshots.length).toBeGreaterThan(0);
    expect(outcome.artifact).toBe(LANDS_UNPAINTED);
    expect(outcome.payload).toBeUndefined();
    expect(outcome.blocking.join(" ")).toContain("render");
    expect(outcome.failure).toBeDefined();
  });

  it("keeps the view when the final save is the one that painted", async () => {
    const outcome = await vendoDriver().run({
      world,
      testCase: caseFor("settled-view"),
      meter: scripted([saveTurn(PAINTS, "c1"), stopTurn()]),
    });

    expect(outcome.artifact).toBe(PAINTS);
    expect(outcome.payload).toBeDefined();
    expect(outcome.blocking).toEqual([]);
    expect(outcome.failure).toBeUndefined();
  });
});

/**
 * Where the settled time went, as this driver can honestly see it. `settledMs`
 * alone says a screen took forty seconds and nothing about which forty; these
 * marks are the only evidence in the run folder that answers that.
 */
describe("the vendo driver's stage marks", () => {
  it("marks the start of assembly, every save it lands and every view it paints", async () => {
    const outcome = await vendoDriver().run({
      world,
      testCase: caseFor("stage-marks"),
      meter: scripted([saveTurn(PAINTS, "c1"), stopTurn()]),
    });

    const labels = outcome.stages?.map((stage) => stage.label) ?? [];
    // Everything before this is the harness's own setup — the store, the guard,
    // the runtime — and charging it to the contender would misread the timeline.
    expect(labels[0]).toBe("assembly");
    // `save_app` is a HAND, not a tool call: the workspace is the only place a
    // save is visible from out here, and the view follows the save that painted.
    expect(labels).toContain("save app.vendo");
    expect(labels.indexOf("save app.vendo")).toBeLessThan(labels.indexOf("view"));

    const times = outcome.stages!.map((stage) => stage.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // One clock read per view, so a snapshot and its mark are the same moment.
    expect(outcome.stages?.filter((stage) => stage.label === "view").map((stage) => stage.atMs)).toEqual(
      outcome.snapshots.map((snapshot) => snapshot.atMs),
    );
  });
});
