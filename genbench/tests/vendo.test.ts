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
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runFloor } from "../src/floor.js";
import type { Meter } from "../src/meter.js";
import { pageHtml } from "../src/render.js";
import type { RunOutcome } from "../src/run.js";
import { vendoDriver } from "../src/vendo.js";
import { cannedResponse, loadWorld, type Case, type World } from "../src/world.js";

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
 *  model — decides what lands. It keeps the brief it was sent, because the only
 *  honest reading of what the vendo column was handed is the prompt that really
 *  went on the wire. `onTurn` runs on the way INTO each turn, which is the one
 *  place a test can reach mid-assembly: the loop has finished every earlier
 *  turn's tool calls by then, and `assemble` has not answered yet. */
function scripted(
  turns: StreamPart[][],
  onTurn: (turn: number) => void = () => undefined,
): Meter & { system: () => string } {
  const remaining = turns.map((turn) => [...turn]);
  let tick = 0;
  let system = "";
  let turn = 0;
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      system = prompt
        .filter((message) => message.role === "system")
        .map((message) => message.content as string)
        .join("\n");
      onTurn(turn++);
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return {
    system: () => system,
    model,
    elapsedMs: () => (tick += 1),
    totals: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }),
    usd: () => 0,
    answeredBy: () => undefined,
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

/**
 * The fairness assertion for the column every other column is measured against.
 *
 * `diy.test.ts` proves each baseline is handed the world block and nothing more.
 * This is the same claim on the vendo side: the screen agent's brief ends with
 * the tools it may hand the person a button for, and that list is the registry's
 * write half — so every write verb the apps runtime happens to serve landed in
 * it with its full JSON Schema. `vendo_apps_pin`, `vendo_apps_unpin`,
 * `vendo_apps_reseed`, `vendo_apps_data_put` and `vendo_apps_data_delete` are
 * not this world's tools, no case can use one, and no baseline is told they
 * exist — they were kilobytes of prompt only this column paid for.
 */
describe("the vendo column is offered the world's tools and nothing else", () => {
  const CALL_HEADING = "## This product's tools your screen can CALL";

  /** The names the brief offers as buttons, read off the prompt the model was
   *  really sent — `toolBrief` prints one `- name — description` line each. */
  const offeredNames = (system: string): readonly string[] =>
    [...(system.split(CALL_HEADING)[1] ?? "").matchAll(/^- (\w+) — /gm)].map((match) => match[1]!);

  it("names exactly the world's own write tools, and no platform verb", async () => {
    const meter = scripted([stopTurn()]);
    await vendoDriver().run({ world, testCase: caseFor("wireable"), meter });

    // The read half is equipped as real tools with their own schemas, so the
    // brief's list is the world's writes — the tools a screen can only reach
    // from a button.
    expect(offeredNames(meter.system())).toEqual(
      world.tools.filter((tool) => tool.descriptor.risk === "write").map((tool) => tool.name),
    );
  });
});

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
    // …and that verdict is what the RUN reports, because the product now says so
    // itself. A run whose last save never painted used to answer `assembled` —
    // the front door found the earlier save's row and stamped a ready receipt —
    // so this driver had to infer the failure by re-running the gate and had
    // nothing but a sentence of its own to report it with. The assembler answers
    // `unavailable` with the floor's own words now, so the reason travels whole:
    // it names WHY nothing painted, which a stand-in never could.
    expect(outcome.failure).toContain("this screen painted nothing");
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
 * The product's OWN review, on the record (2026-08-18).
 *
 * `result.json` carried the judge's verdict and nothing about how the screen got
 * there, so a failed rubric line could not be told apart from a reviewer that
 * never mentioned the defect. The driver already fills the `validate` verb the
 * gate answers through, so the verdict costs nothing to watch — and this is a seam
 * test, so the gate that answers here is the product's real one.
 */
describe("the vendo driver records the product's own review", () => {
  it("carries the verdict the gate reached, and whether anything painted after it", async () => {
    const outcome = await vendoDriver().run({
      world,
      testCase: caseFor("reviewed"),
      meter: scripted([saveTurn(PAINTS, "c1"), stopTurn()]),
    });

    // The loop reviews the screen it is about to hand over, so a run that painted
    // carries one verdict, reached after the paint it is about.
    expect(outcome.pipeline?.reviews).toHaveLength(1);
    expect(outcome.pipeline?.reviews[0]).toMatchObject({ ok: true, findings: [] });
    expect(outcome.pipeline!.reviews[0]!.atMs).toBeGreaterThan(outcome.snapshots[0]!.atMs);
    // Nothing painted after the verdict, which is what a screen with nothing to
    // repair looks like. A `true` here is the only sign from out here that a
    // repair round wrote something that reached the person.
    expect(outcome.pipeline?.paintedAfter).toBe(false);
  });

  it("reports no review at all for a screen the product never reviewed", async () => {
    const outcome = await vendoDriver().run({
      world,
      testCase: caseFor("unreviewed"),
      meter: scripted([saveTurn(PAINTS, "c1"), saveTurn(LANDS_UNPAINTED, "c2"), stopTurn()]),
    });

    // The gate runs on a screen that painted, and the delivered document is not
    // one: the last save landed and painted nothing. So those bytes went out
    // unreviewed, and the absence is what says so — a reading no judge's verdict
    // could give, because the judge grades the screen and not the road to it.
    expect(outcome.blocking).toHaveLength(1);
    expect(outcome.pipeline).toBeUndefined();
  });
});

/**
 * A screen painted before the bell is a real screen.
 *
 * A case that hit its cap used to be recorded as having delivered NOTHING — the
 * floor failed `delivered`, the judge failed all twelve rubric lines, and the
 * assembler had painted and saved several times before the clock ran out. That
 * is the harness's clock graded as the contender's quality. So a spent budget
 * ends the WAIT and nothing else: whatever landed and whatever last painted is
 * reported, through the same read a case that finished on time makes, with the
 * cap said out loud beside it.
 *
 * The other half is the store: `assemble` takes no signal, so the assembler runs
 * on and its stragglers keep reporting audit rows through this store. Closing it
 * under them is what turned one zombie's write into `[vendo] store is closed`
 * with nobody to catch it, and ended a whole run.
 */
describe("a case whose budget runs out", () => {
  /** The driver's own warning, captured rather than printed. */
  async function ranOut(run: () => Promise<RunOutcome>): Promise<{ outcome: RunOutcome; warned: string }> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...said: unknown[]) => void lines.push(said.join(" ")));
    try {
      return { outcome: await run(), warned: lines.join("\n") };
    } finally {
      spy.mockRestore();
    }
  }

  /** The budget expiring MID-assembly, which is the shape a real run has: the
   *  first save has landed and painted, and the loop is asking for its next turn
   *  when the bell rings. */
  const outOfTime = async (id: string): Promise<{ outcome: RunOutcome; warned: string }> => {
    const spent = new AbortController();
    return await ranOut(
      async () =>
        await vendoDriver().run({
          world,
          testCase: caseFor(id),
          meter: scripted([saveTurn(PAINTS, "c1"), stopTurn()], (turn) => {
            if (turn === 1) spent.abort();
          }),
          signal: spent.signal,
        }),
    );
  };

  it("hands back the last screen it painted, and the floor reads it as delivered", async () => {
    const { outcome } = await outOfTime("out-of-time");

    // It really did paint before the bell — without this the case proves nothing.
    expect(outcome.snapshots.length).toBeGreaterThan(0);
    expect(outcome.artifact).toBe(PAINTS);
    expect(outcome.payload).toBeDefined();
    expect(outcome.blocking).toEqual([]);
    expect(outcome.failure).toContain("the case's budget ran out");

    // Graded through the run's OWN floor, with no stub on either side: a
    // salvaged screen is a delivered screen. `renders` is the browser's word and
    // not this seam's, so it is not what is being asked here.
    const floor = runFloor({
      world,
      artifact: outcome.artifact,
      blocking: outcome.blocking,
      trace: [],
      renders: false,
      tags: [],
    });
    expect(floor.delivered).toBe(true);
    expect(floor.valid).toBe(true);
    // And the payload is a payload: the run's own page builder takes it.
    expect(pageHtml(outcome.payload!, world, "", "vendo-sonnet")).toContain("This month");
  });

  it("still delivers nothing when the budget was gone before anything painted", async () => {
    const spent = new AbortController();
    spent.abort();

    const { outcome } = await ranOut(
      async () =>
        await vendoDriver().run({
          world,
          testCase: caseFor("nothing-painted"),
          meter: scripted([saveTurn(PAINTS, "c1"), stopTurn()]),
          signal: spent.signal,
        }),
    );

    expect(outcome.snapshots).toEqual([]);
    expect(outcome.artifact).toBeUndefined();
    expect(outcome.payload).toBeUndefined();
    expect(outcome.failure).toContain("the case's budget ran out");
    expect(
      runFloor({ world, artifact: outcome.artifact, blocking: outcome.blocking, trace: [], renders: false, tags: [] })
        .delivered,
    ).toBe(false);
  });

  it("leaves its store open for the work still using it, and says so", async () => {
    const { warned } = await outOfTime("abandoned");

    expect(warned).toContain("abandoned's store stays open");
  });
});

/** The other half of `diy.test.ts`'s fairness assertion. Every baseline reads
 *  each descriptor in its own prompt (`worldBlock`); vendo was briefed with
 *  neither, so it had to spend a paid turn calling a tool to learn what it
 *  answers with. Read off the prompt the assembler really sent, because the
 *  briefing that counts is the one on the wire. */
describe("the vendo driver's briefing", () => {
  /** The system prompt the assembler really sent — the briefing that counts is
   *  the one on the wire, not the pack a helper returns. */
  async function systemPrompt(each: World, id: string): Promise<string> {
    const meter = scripted([saveTurn(PAINTS, "c1"), stopTurn()]);
    await vendoDriver().run({ world: each, testCase: caseFor(id), meter });
    return (meter.model as MockLanguageModelV3).doStreamCalls[0]!.prompt
      .filter((message) => message.role === "system")
      .map((message) => message.content as string)
      .join("\n");
  }

  it("carries every world tool's descriptor, and none of their answers", async () => {
    const sent = await systemPrompt(world, "briefed");

    for (const tool of world.tools) expect(sent).toContain(JSON.stringify(tool.descriptor, null, 2));
    // The canned rows stay out: vendo calls these tools for real.
    const reads = world.tools.find((tool) => tool.data !== undefined)!;
    expect(sent).not.toContain(JSON.stringify(cannedResponse(reads), null, 2));
  });

  /** Shapes are symmetric — every column reads each descriptor. What a field
   *  MEANS is not handed over: the unit lives in the tool's own prose, and vendo
   *  infers it at generation time exactly like every rival. A card naming this
   *  world's fields with their units would be vendo marking its own exam.
   *
   *  The Kit's generic teaching of the `semantic` prop is a different thing and
   *  stays: it is a product feature every host configures, and it names no field
   *  of this world. So the pin is on the DERIVED line — `compute_cost` is the
   *  field the whole card existed for, stated in CENTS in the prose below and
   *  nowhere else. */
  it("spells out no field's units, which no rival is told either", async () => {
    const sent = await systemPrompt(await loadWorld(join(root, "worlds", "buildlog")), "no-units");

    // The prose the model reads for itself really is there — otherwise this
    // pins the absence of a world rather than the absence of a card.
    expect(sent).toContain("CENTS");
    expect(sent).not.toContain("compute_cost: money.cents");
    expect(sent).not.toContain("FIELD UNITS");
  });
});
