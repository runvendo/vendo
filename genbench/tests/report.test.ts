/**
 * What the one page a person actually opens has to get right: a column per
 * contender in a fixed order however the row finished, one section per case, and
 * beside each case the data its screens were graded against — the case's own,
 * overrides applied, or the panel is worse than useless.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { FloorResult } from "../src/floor.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import { writePreview } from "../src/report.js";
import type { CaseResult } from "../src/run.js";
import { loadCases, loadWorld, worldForCase, type World } from "../src/world.js";

const PASSING: FloorResult = {
  delivered: true,
  renders: true,
  valid: true,
  blocking: [],
  honestData: { pass: true, offenders: [], examined: 3 },
  wiredActions: { pass: true, bindings: [] },
  pass: true,
};

/** The vacuous pass: nothing on the screen was extractable, so the floor
 *  cleared trivially rather than because anything was actually checked. */
const NOTHING_TO_CHECK: FloorResult = {
  ...PASSING,
  honestData: { pass: true, offenders: [], examined: 0 },
};

/** One of each verdict, so a row that only handles two of them shows up. Two
 *  case lines with one pass, two style lines with one pass and one `na`. */
const JUDGED: JudgeResult = {
  lines: [
    { line: "shows every pending transfer the tool returned", source: "case", verdict: "pass", note: "three rows are listed" },
    { line: "each transfer names who it is going to", source: "case", verdict: "fail", note: "the rows show amounts and no recipient" },
    { line: "money always shows 2 decimals with a currency symbol", source: "style", verdict: "pass", note: "amounts render as $1,250.00" },
    { line: "destructive actions ask for confirmation", source: "style", verdict: "na", note: "nothing on this screen is destructive" },
  ],
  degraded: false,
};

const resultFor = (contender: string, testCase: string, prompt: string, judged: JudgeResult = JUDGED): CaseResult => ({
  run: "run-1",
  contender,
  model: "claude-sonnet-5",
  case: testCase,
  prompt,
  lane: "screen",
  floor: PASSING,
  timing: { firstRenderMs: 1_000, settledMs: 2_000 },
  cost: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 }, usd: 0.01 },
  islands: 0,
  clientOnly: 0,
  trace: [],
  consoleErrors: [],
  world: "hash",
  caseHash: "case-hash",
  judged,
  judgeContract: JudgeContract,
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let emptyWorld: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  const cases = await loadCases(join(root, "worlds", "maple", "cases.json"));
  emptyWorld = worldForCase(world, cases.find((entry) => entry.id === "no-pending-transfers")!);
});

/** The page escapes everything it prints — a tool name on it came out of a
 *  model — so an assertion about JSON on the page has to be escaped too. */
const onPage = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const preview = async (results: readonly CaseResult[], worlds: Record<string, World>): Promise<string> => {
  const runDir = await mkdtemp(join(tmpdir(), "genbench-report-"));
  await writeFile(join(runDir, "preview-input.json"), "{}");
  return await readFile(await writePreview({ runDir, runId: "run-1", results, worlds }), "utf8");
};

describe("the preview page", () => {
  it("keeps the column order it was given, whoever finished first", async () => {
    const html = await preview(
      [resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."), resultFor("diy-sonnet", "pending-transfers", "Show my pending transfers.")],
      { "pending-transfers": world },
    );

    expect(html.indexOf("vendo-sonnet")).toBeLessThan(html.indexOf("diy-sonnet"));
  });

  it("gives every case its own section rather than stacking them under one prompt", async () => {
    const html = await preview(
      [
        resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."),
        resultFor("diy-sonnet", "pending-transfers", "Show my pending transfers."),
        resultFor("vendo-sonnet", "spend-overview", "Show me where my money went."),
        resultFor("diy-sonnet", "spend-overview", "Show me where my money went."),
      ],
      { "pending-transfers": world, "spend-overview": world },
    );

    expect(html.split(`class="case"`).length - 1).toBe(2);
    expect(html).toContain("Show my pending transfers.");
    expect(html).toContain("Show me where my money went.");
  });

  it("shows the case's own tool data, overrides applied, not the authored world", async () => {
    const html = await preview([resultFor("vendo-sonnet", "no-pending-transfers", "Show my pending transfers.")], {
      "no-pending-transfers": emptyWorld,
    });

    expect(html).toContain("World data");
    expect(html).toContain("cancel_transfer");
    // The empty override is what these screens were graded against…
    expect(html).toContain(onPage({ data: [] }));
    // …so the authored rows must not be sitting beside them as if they were.
    expect(html).not.toContain("Alex Rivera");
    // A write tool answers with its acknowledgement, the same one the page gives.
    expect(html).toContain(onPage({ ok: true }));
  });

  it("prints every rubric line with its verdict and the evidence the judge named", async () => {
    const html = await preview([resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.")], {
      "pending-transfers": world,
    });

    for (const line of JUDGED.lines) {
      expect(html).toContain(line.line);
      // The note is on the page, not behind a hover: the founder reads this
      // every day and a verdict with no evidence beside it is unarguable.
      expect(html).toContain(line.note);
      expect(html).toContain(`<li class="${line.verdict}">`);
    }
    // Case lines are the correctness half, style lines the design half, and the
    // case lines come first.
    expect(html.indexOf("shows every pending transfer the tool returned")).toBeLessThan(
      html.indexOf("money always shows 2 decimals with a currency symbol"),
    );
  });

  it("tallies each half and leaves an `na` line out of the denominator", async () => {
    const html = await preview([resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.")], {
      "pending-transfers": world,
    });

    // Two case lines, one passed. Two style lines, one passed and one whose
    // subject is not on this screen at all — that one is neither earned nor
    // missed, so counting it would grade the screen for what it does not have.
    expect(html).toContain(`<span>correctness</span><b>1/2</b>`);
    expect(html).toContain(`<span>design</span><b>1/1</b>`);
  });

  it("says a degraded judgement out loud, and prints no tally that would read as a score", async () => {
    const degraded: JudgeResult = {
      lines: JUDGED.lines.map((line) => ({ ...line, verdict: "fail", note: "the judge did not grade this screen" })),
      degraded: true,
      error: "529 overloaded",
    };
    const html = await preview([resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.", degraded)], {
      "pending-transfers": world,
    });

    expect(html).toContain("judge degraded");
    expect(html).toContain("529 overloaded");
    // Every line reads `fail`, so a literal tally would print 0/2 — which is a
    // sentence about the contender, and it would be false.
    expect(html).not.toContain(`<b>0/2</b>`);
    expect(html).toContain(`<span>correctness</span><b>—</b>`);
  });

  it("shows what grading cost on its own line, and leaves it out of every column", async () => {
    const graded = resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.");
    const html = await preview(
      [
        {
          ...graded,
          judged: {
            ...graded.judged,
            cost: {
              usage: { inputTokens: 3_000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
              usd: 0.025,
            },
          },
        },
      ],
      { "pending-transfers": world },
    );

    expect(html).toContain("judge · 1 screen graded");
    expect(html).toContain("3,400 tokens");
    expect(html).toContain("$0.0250");
    // The contender's own cost is untouched — the two numbers must never merge.
    expect(html).toContain(`<dd>$0.0100</dd>`);
  });

  it("says nothing about judge spend when no screen was graded", async () => {
    const html = await preview([resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.")], {
      "pending-transfers": world,
    });

    expect(html).not.toContain("judge ·");
  });

  it("carries the listener that turns a press in an embedded page into a feed row", async () => {
    const html = await preview([resultFor("vendo-sonnet", "spend-overview", "Show me where my money went.")], {
      "spend-overview": world,
    });

    expect(html).toContain(`<ol id="feed">`);
    expect(html).toContain(`addEventListener("message"`);
    expect(html).toContain(`call.genbench !== "call"`);
  });

  it("shows a vacuous honestData pass as muted, not a clean checkmark", async () => {
    const html = await preview(
      [{ ...resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."), floor: NOTHING_TO_CHECK }],
      { "pending-transfers": world },
    );

    expect(html).toContain("nothing to check");
    expect(html).toContain(`<dd><span class="v muted">`);
    // Not the same markup a real pass earns — a vacuous pass must not read as
    // the check having found and cleared anything.
    expect(html).not.toContain(`<dd><span class="v ok">✓ · 0 values checked</span></dd>`);
  });
});
