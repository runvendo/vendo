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

/** One default-exported component rendering one Kit tree is the whole of the
 *  gauntlet's gate, so this is the smallest screen that legitimately paints. */
const PAINTS = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="This month" />
    </Stack>
  );
}`;

/** Compiles, scans and type-checks clean — and then paints nothing, because the
 *  component returns null. The seam lands its bytes and the gauntlet refuses it
 *  at the stage that RUNS the screen, which is the only stage that could tell. */
const LANDS_UNPAINTED = `export default function Spending() {
  return null;
}`;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
});

const caseFor = (id: string): Case => ({ id, lane: "screen", prompt: "Show this month's spending", pass: [], shape: "table" });

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
    // The gauntlet's own verdict on the bytes that landed, verbatim and alone —
    // one finding, naming the stage that ran the screen.
    expect(outcome.blocking).toHaveLength(1);
    expect(outcome.blocking[0]).toContain("this screen painted nothing");
    expect(outcome.failure).toBe("the delivered document does not render, so no screen is reported for it");
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
