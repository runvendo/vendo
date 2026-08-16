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
import { AUDITOR_CONTRACT } from "../src/audit.js";
import { wiredActions, type FloorResult } from "../src/floor.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import { writePreview, writeSummary, type RunSummary } from "../src/report.js";
import type { CaseResult } from "../src/run.js";
import { TriageContract } from "../src/triage.js";
import { loadCases, loadWorld, worldForCase, type World } from "../src/world.js";

const PASSING: FloorResult = {
  delivered: true,
  renders: true,
  valid: true,
  blocking: [],
  honestData: { pass: true, offenders: [], examined: 3, found: 3 },
  wiredActions: { pass: true, pressed: 0, bindings: [] },
  pass: true,
};

/** The vacuous pass: nothing on the screen was extractable, so the floor
 *  cleared trivially rather than because anything was actually checked. */
const NOTHING_TO_CHECK: FloorResult = {
  ...PASSING,
  honestData: { pass: true, offenders: [], examined: 0, found: 0 },
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
  shape: "table",
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
  triageContract: TriageContract,
  auditorContract: AUDITOR_CONTRACT,
  gitSha: "0".repeat(40),
  agentSdkVersion: "0.0.0",
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

  /**
   * The screen a case was mined from is provenance, and this page is the only
   * place anyone reads it — the field sat in `cases.json` with no reader at all
   * until here. Two thirds of the cases were mined from nothing, and their
   * headers must read exactly as they did before the field existed.
   */
  it("names the real screen a case was mined from, links it, and prints nothing for a case without one", async () => {
    const html = await preview(
      [
        {
          ...resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."),
          source: "Monarch — Transactions, https://www.monarchmoney.com/features",
        },
        resultFor("vendo-sonnet", "spend-overview", "Show me where my money went."),
      ],
      { "pending-transfers": world, "spend-overview": world },
    );

    expect(html).toContain(
      `<p class="source">from Monarch — Transactions, <a href="https://www.monarchmoney.com/features">https://www.monarchmoney.com/features</a></p>`,
    );
    // One of the two cases was mined; the other prints no source markup at all.
    expect(html.split(`class="source"`).length - 1).toBe(1);
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

  it("tallies each half and leaves a DESIGN `na` line out of the denominator", async () => {
    const html = await preview([resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.")], {
      "pending-transfers": world,
    });

    // Two case lines, one passed. Two style lines, one passed and one whose
    // subject is not on this screen at all — that one is neither earned nor
    // missed, so counting it would grade the screen for what it does not have.
    expect(html).toContain(`<span>correctness</span><b>1/2</b>`);
    expect(html).toContain(`<span>design</span><b>1/1</b>`);
  });

  /**
   * A CORRECTNESS line is the case itself, so `na` on one is not "there was
   * nothing here to grade" — it is "the screen has no sign of what it was asked
   * for", which is a fail. Excluding it shrank the denominator, so omitting a
   * feature outscored building it imperfectly, and two columns of one case were
   * scored out of two different totals.
   */
  it("counts an `na` on a case line as a fail rather than shrinking the denominator", async () => {
    const skipped: JudgeResult = {
      lines: [
        ...JUDGED.lines,
        { line: "cancels a transfer from the row", source: "case", verdict: "na", note: "no cancel control is on this screen" },
      ],
      degraded: false,
    };
    const html = await preview(
      [resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.", skipped)],
      { "pending-transfers": world },
    );

    // Three case lines, one passed, and the `na` is one of the three.
    expect(html).toContain(`<span>correctness</span><b>1/3</b>`);
    // The design half is untouched: its `na` is legitimate and still sits out.
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

  /**
   * The one place on this page a contender's screens are added up, so the sum
   * is what has to be checked — and a shape a contender never ran must not be
   * scored: 0/0 painted green is a claim about a contender nobody put to the test.
   */
  it("adds a contender's checks up by shape, and leaves a shape it never ran unscored", async () => {
    const html = await preview(
      [
        resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."),
        resultFor("diy-sonnet", "pending-transfers", "Show my pending transfers."),
        {
          ...resultFor("vendo-sonnet", "spend-overview", "Show me where my money went."),
          floor: { ...PASSING, renders: false, valid: false, pass: false },
        },
        { ...resultFor("vendo-sonnet", "spend-chart", "Chart my spending by category."), shape: "chart" },
      ],
      { "pending-transfers": world, "spend-overview": world, "spend-chart": world },
    );

    // Two table cases at five checks each, less the vacuous `wiredActions` on
    // each screen (nothing to press): vendo ran both and lost two checks on one,
    // diy ran one of the two and held everything on it.
    expect(html).toContain(`<tr><th>table</th><td>2</td><td class="no">6/8 · 2 vacuous</td><td class="ok">4/4 · 1 vacuous</td></tr>`);
    // Only vendo ran the chart case, so diy's cell says so rather than scoring it.
    expect(html).toContain(`<tr><th>chart</th><td>1</td><td class="ok">4/4 · 1 vacuous</td><td class="muted">—</td></tr>`);
    // Shapes nobody ran are not rows at all.
    expect(html).not.toContain(`<th>form</th>`);
  });

  /**
   * The one aggregate on this page, and it was adding up bare booleans — so a
   * screen with no numbers on it and nothing to press scored a full 5/5 here,
   * on two checks that were never in front of it, while the column below was
   * already muting both as unearned. A cell that disagrees with the card under
   * it is worse than no cell.
   */
  it("keeps a vacuous check out of the shape table's numerator and its denominator", async () => {
    const html = await preview(
      [{ ...resultFor("vendo-sonnet", "blank", "Show me nothing."), floor: NOTHING_TO_CHECK }],
      { blank: world },
    );

    // Three checks were really in front of it; the other two had nothing to be.
    expect(html).toContain(`<td class="ok">3/3 · 2 vacuous</td>`);
    expect(html).not.toContain(`<td class="ok">5/5</td>`);
    // And the card's own header agrees with the table above it, to the digit.
    expect(html).toContain(`<span class="score ok">3/3 · 2 vacuous</span>`);
  });

  /** A check our own triage or auditor could not be reached for is not the
   *  contender fabricating data, so it does not score and does not fail. */
  it("keeps a degraded honesty check out of the score, and says so instead of a red mark", async () => {
    const outage: FloorResult = {
      ...PASSING,
      honestData: {
        pass: false,
        offenders: [{ kind: "number", text: "$9,999.00", at: 0, why: "no executable derivation cleared it" }],
        examined: 1,
        found: 1,
        degraded: true,
        error: "529 overloaded",
      },
    };
    const html = await preview(
      [{ ...resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."), floor: outage }],
      { "pending-transfers": world },
    );

    expect(html).toContain("— not checked");
    expect(html).toContain(`1 degraded`);
    expect(html).not.toContain(`<span class="v no">✕ fail</span>`);
  });

  it("carries the listener that turns a press in an embedded page into a feed row", async () => {
    const html = await preview([resultFor("vendo-sonnet", "spend-overview", "Show me where my money went.")], {
      "spend-overview": world,
    });

    expect(html).toContain(`<ol id="feed">`);
    expect(html).toContain(`addEventListener("message"`);
    expect(html).toContain(`call.genbench !== "call"`);
  });

  /**
   * The floor decides a press holds; this page is where anyone reads that. Both
   * halves run for real here — the grader's own bindings go to the real reporter,
   * with nothing hand-written between them — because the two spell the same
   * verdict separately and a state-only pass showing a red ✕ is the kind of
   * disagreement neither side can see alone.
   */
  it("marks a state-only control as a pass, with the reason it passed, and a dead one as a fail", async () => {
    const graded = wiredActions(
      [
        { label: "Details", confirmed: false, changed: true, calls: [] },
        { label: "Refresh", confirmed: false, changed: false, calls: [] },
      ],
      world,
    );
    const html = await preview(
      [
        {
          ...resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."),
          floor: { ...PASSING, wiredActions: graded, pass: false },
        },
      ],
      { "pending-transfers": world },
    );

    // Opening a dialog, switching a tab, dismissing a row: it asked the host for
    // nothing and it is not dead, and the page says which of the two it is.
    expect(html).toContain(
      `<li><code>Details</code> <span>changed the screen without calling a tool</span> <i class="ok">✓</i></li>`,
    );
    expect(html).toContain(
      `<li><code>Refresh</code> <span>pressing it called nothing and changed nothing</span> <i class="no">✕</i></li>`,
    );
  });

  /** The cap is silent in the result unless the page says so: "20 values
   *  checked" and "20 of 93 values checked" are different claims about a screen,
   *  and only one of them was ever printed. */
  it("says how many of the screen's numbers were actually examined when the cap bit", async () => {
    const capped: FloorResult = {
      ...PASSING,
      honestData: { pass: true, offenders: [], examined: 20, found: 93 },
    };
    const html = await preview(
      [{ ...resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."), floor: capped }],
      { "pending-transfers": world },
    );

    expect(html).toContain("20 of 93 values checked");
  });

  /** An `action` case can fail `wiredActions` while every press on it holds, so
   *  the check's own reason has to be readable beside them or the column shows a
   *  red mark over a row of green ticks. */
  it("prints why an action case failed when no single press did", async () => {
    const unproven = wiredActions([{ label: "Details", confirmed: false, changed: true, calls: [] }], world, ["action"]);
    const html = await preview(
      [
        {
          ...resultFor("vendo-sonnet", "cancel-transfer", "Cancel the transfer to Alex."),
          floor: { ...PASSING, wiredActions: unproven, pass: false },
        },
      ],
      { "cancel-transfer": world },
    );

    expect(html).toContain("no press ever asked the host for anything");
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

  /** The same two readings of a pass, on the other check that has them: a screen
   *  with nothing to press passes without one control having been proven live. */
  it("tells a screen whose controls all held apart from one with nothing to press", async () => {
    const live = wiredActions(
      [
        { label: "Cancel", confirmed: false, changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
        { label: "Details", confirmed: false, changed: true, calls: [] },
      ],
      world,
    );
    const base = resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.");

    const pressed = await preview([{ ...base, floor: { ...PASSING, wiredActions: live } }], {
      "pending-transfers": world,
    });
    expect(pressed).toContain(`✓ · 2 controls pressed`);

    const vacuous = await preview([base], { "pending-transfers": world });
    expect(vacuous).toContain("nothing to press");
    expect(vacuous).not.toContain("controls pressed");
  });

  /**
   * The audit block is where a reader overturns the honesty check, so it has to
   * show what settled every value — including the ones a MODEL waived, in the
   * clause it waived them with. A waiver nobody can read is a waiver nobody can
   * argue with.
   */
  it("prints what settled every value: the tools' own text, a triage waiver, and an executed program", async () => {
    const settled: FloorResult = {
      ...PASSING,
      honestData: {
        pass: true,
        offenders: [],
        examined: 3,
        found: 3,
        audited: [
          { text: "4471", program: "", result: "the tool data answers with this exact text", verdict: "cleared-by-verbatim", attempts: 0 },
          { text: "12", program: "", result: "the hour on a clock", verdict: "skipped-by-triage", attempts: 0 },
          { text: "67.2", program: "return share(data);", result: "67.2", verdict: "cleared-by-audit", attempts: 2 },
        ],
      },
    };
    const html = await preview(
      [{ ...resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."), floor: settled }],
      { "pending-transfers": world },
    );

    expect(html).toContain("cleared — the tool data answers with this exact text");
    expect(html).toContain("not a data claim — the hour on a clock");
    expect(html).toContain("cleared — executed to 67.2 · 2 attempts");
    // The program is on the page, not behind a hover.
    expect(html).toContain("return share(data);");
    // Two values cleared of the two that were checked, and the waived one is
    // named rather than counted into either side.
    expect(html).toContain(`<b>2/2 · 1 waived</b>`);
    // A waiver is not a pass and not a failure: the same recessive row a rubric
    // line whose subject is absent gets.
    expect(html).toContain(`<li class="na">`);
  });
});

/**
 * The run's headline, which did not exist in code.
 *
 * Everything the benchmark wrote was per case — a folder per case, a preview
 * section per case, a floor table broken out by shape — so 200 cases across
 * fourteen worlds produced 200 verdicts and no total anywhere, and the question
 * the whole thing exists to answer had to be added up by hand.
 */
describe("summary.json", () => {
  const summaryOf = async (results: readonly CaseResult[]): Promise<RunSummary> => {
    const runDir = await mkdtemp(join(tmpdir(), "genbench-summary-"));
    const path = await writeSummary({ runDir, runId: "run-1", results, gitSha: "0".repeat(40) });
    return JSON.parse(await readFile(path, "utf8")) as RunSummary;
  };

  it("adds one column's floor cells up, keeping vacuous and degraded out of both halves", async () => {
    const summary = await summaryOf([
      resultFor("vendo-sonnet", "a", "one"),
      { ...resultFor("vendo-sonnet", "b", "two"), floor: { ...PASSING, renders: false, pass: false } },
      { ...resultFor("vendo-sonnet", "c", "three"), floor: NOTHING_TO_CHECK },
    ]);

    // Three screens: 4 graded cells each on the first two (wiredActions is
    // vacuous on every one of them), 3 on the blank one.
    expect(summary.columns["vendo-sonnet"]!.floor).toEqual({ earned: 10, failed: 1, vacuous: 4, degraded: 0 });
    expect(summary.columns["vendo-sonnet"]!.cases).toBe(3);
  });

  it("counts rubric lines by half, so an `na` on a case line is not a line that vanished", async () => {
    const summary = await summaryOf([resultFor("vendo-sonnet", "a", "one")]);

    expect(summary.columns["vendo-sonnet"]!.caseLines).toEqual({ pass: 1, fail: 1, na: 0 });
    expect(summary.columns["vendo-sonnet"]!.styleLines).toEqual({ pass: 1, fail: 0, na: 1 });
  });

  it("counts the run's own failures — timeouts and a judge that was down — as its own", async () => {
    const degraded: JudgeResult = { ...JUDGED, degraded: true, error: "529 overloaded" };
    const summary = await summaryOf([
      { ...resultFor("vendo-sonnet", "a", "one"), failure: "timeout" },
      { ...resultFor("vendo-sonnet", "b", "two", degraded) },
      resultFor("diy-sonnet", "a", "one"),
    ]);

    expect(summary.columns["vendo-sonnet"]).toMatchObject({ timeouts: 1, judgeDegraded: 1 });
    expect(summary.columns["diy-sonnet"]).toMatchObject({ timeouts: 0, judgeDegraded: 0 });
  });

  it("carries what the numbers were produced by, so two summaries can be told apart", async () => {
    const summary = await summaryOf([resultFor("vendo-sonnet", "a", "one")]);

    expect(summary).toMatchObject({
      run: "run-1",
      gitSha: "0".repeat(40),
      rubricVersion: JudgeContract.rubricVersion,
      auditVersion: AUDITOR_CONTRACT.auditVersion,
      triageVersion: TriageContract.triageVersion,
    });
    expect(summary.models).toContain("claude-sonnet-5");
  });

  it("totals what each column spent, and each column only", async () => {
    const summary = await summaryOf([
      resultFor("vendo-sonnet", "a", "one"),
      resultFor("vendo-sonnet", "b", "two"),
      resultFor("diy-sonnet", "a", "one"),
    ]);

    expect(summary.columns["vendo-sonnet"]).toMatchObject({ tokens: 4, usd: 0.02 });
    expect(summary.columns["diy-sonnet"]).toMatchObject({ tokens: 2, usd: 0.01 });
  });
});
