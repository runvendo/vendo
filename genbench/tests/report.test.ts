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
import { wiredActions, type FloorResult } from "../src/floor.js";
import { HONESTY_LINE, JudgeContract, type JudgeResult } from "../src/judge.js";
import type { Probed } from "../src/probe.js";
import { VIEWPORT } from "../src/render.js";
import { writePreview, writeSummary, type RunSummary } from "../src/report.js";
import { unjudged, type CaseResult } from "../src/run.js";
import { loadCases, loadWorld, worldForCase, type World } from "../src/world.js";

const PASSING: FloorResult = {
  delivered: true,
  renders: true,
  valid: true,
  blocking: [],
  wiredActions: { pass: true, pressed: 0, bindings: [] },
  pass: true,
};

/** The other reading of a `wiredActions` pass: controls really were pressed and
 *  really held, so the cell was earned rather than cleared vacuously. */
const CONTROLS_HELD: FloorResult = {
  ...PASSING,
  wiredActions: { pass: true, pressed: 2, bindings: [] },
};

/** One of each verdict, so a row that only handles two of them shows up. Two
 *  case lines with one pass, the standing honesty line every case is asked, and
 *  two style lines with one pass and one `na`. */
const JUDGED: JudgeResult = {
  lines: [
    { line: "shows every pending transfer the tool returned", source: "case", verdict: "pass", note: "three rows are listed" },
    { line: "each transfer names who it is going to", source: "case", verdict: "fail", note: "the rows show amounts and no recipient" },
    { line: HONESTY_LINE, source: "case", verdict: "pass", note: "every amount is one the tool returned" },
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

const preview = async (
  results: readonly CaseResult[],
  worlds: Record<string, World>,
  actionCases?: ReadonlySet<string>,
): Promise<string> => {
  const runDir = await mkdtemp(join(tmpdir(), "genbench-report-"));
  await writeFile(join(runDir, "preview-input.json"), "{}");
  return await readFile(
    await writePreview({ runDir, runId: "run-1", results, worlds, ...(actionCases === undefined ? {} : { actionCases }) }),
    "utf8",
  );
};

/** One screen's floor as the REAL grader scores the presses it was given. The
 *  write axis is a re-read of exactly these bindings, so hand-writing them
 *  would prove only the hand. */
const pressed = (contender: string, testCase: string, trace: readonly Probed[]): CaseResult => ({
  ...resultFor(contender, testCase, "one"),
  floor: { ...PASSING, wiredActions: wiredActions(trace, world, ["action"]) },
  trace,
});

const CANCELLED: readonly Probed[] = [
  { label: "Cancel", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
];

/**
 * Four screens, one set of evidence: a press that reached the host's write, a
 * press that got as far as a confirmation, a press that called the host and
 * asked it for ROWS — reading is not acting, which is the distinction the axis
 * draws — and a DISPLAY case whose press happened to write, which is in
 * nobody's fraction because nobody asked that screen to do anything.
 *
 * A function because the world is loaded in `beforeAll`, and one fixture
 * because `summary.json` and the page are two readings of the same evidence
 * and must never be handed two different sets of it.
 */
const presses = (): CaseResult[] => [
  pressed("vendo-sonnet", "cancel-transfer", CANCELLED),
  pressed("vendo-sonnet", "confirm-first", [
    { label: "Cancel", changed: true, dialog: "Cancel the transfer to Alex?", calls: [] },
  ]),
  pressed("vendo-sonnet", "refresh-only", [
    { label: "Refresh", changed: false, calls: [{ name: "list_transfers", args: { limit: 5 } }] },
  ]),
  pressed("diy-sonnet", "spend-overview", CANCELLED),
];

const ASKED_TO_ACT = new Set(["cancel-transfer", "confirm-first", "refresh-only"]);

const pressedWorlds = (): Record<string, World> =>
  Object.fromEntries(presses().map((result) => [result.case, world]));

describe("the preview page", () => {
  it("keeps the column order it was given, whoever finished first", async () => {
    const html = await preview(
      [resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."), resultFor("diy-sonnet", "pending-transfers", "Show my pending transfers.")],
      { "pending-transfers": world },
    );

    expect(html.indexOf("vendo-sonnet")).toBeLessThan(html.indexOf("diy-sonnet"));
  });

  it("frames the embedded screen at the graded VIEWPORT, one contender per row rather than squeezed three to a column", async () => {
    const html = await preview([resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.")], { "pending-transfers": world });

    // One per row, not the old three-wide grid: a narrower box would reflow a
    // contender's page into a layout the judge never scored.
    expect(html).toContain(".grid{display:grid;grid-template-columns:1fr;");
    // The iframe itself caps at the graded frame's own width and shape, so a
    // wide-enough monitor shows the contender's page at the size it was judged.
    expect(html).toContain(`max-width:${VIEWPORT.width}px;aspect-ratio:${VIEWPORT.width}/${VIEWPORT.height}`);
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
    expect(html).toContain(`<span>the ask</span><b>1/2</b>`);
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
    expect(html).toContain(`<span>the ask</span><b>1/3</b>`);
    // The design half is untouched: its `na` is legitimate and still sits out.
    expect(html).toContain(`<span>design</span><b>1/1</b>`);
  });

  /**
   * The correctness column was answering two questions at once — whether the
   * screen showed what was asked, and whether the numbers on it are real — so a
   * screen that invented a figure and a screen that missed a row moved the same
   * number by the same amount, and neither said which had happened.
   */
  it("scores the honesty line in a row of its own, never inside correctness", async () => {
    const invented: JudgeResult = {
      lines: JUDGED.lines.map((line) =>
        line.line === HONESTY_LINE
          ? { ...line, verdict: "fail" as const, note: "the balance is on no tool's answer" }
          : line,
      ),
      degraded: false,
    };
    const html = await preview(
      [resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers.", invented)],
      { "pending-transfers": world },
    );

    // The screen did what it was asked exactly as well as it did before; what it
    // made up is a different sentence, and it is said on a line of its own.
    expect(html).toContain(`<span>the ask</span><b>1/2</b>`);
    expect(html).toContain(`<span>honesty</span><b>0/1</b>`);
    expect(html).toContain(`<span>design</span><b>1/1</b>`);
    // In the order the rubric is asked in: what it showed, whether it is true,
    // then how it looks.
    expect(html.indexOf(">the ask<")).toBeLessThan(html.indexOf(">honesty<"));
    expect(html.indexOf(">honesty<")).toBeLessThan(html.indexOf(">design<"));
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
    expect(html).toContain(`<span>the ask</span><b>—</b>`);
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

    // Two table cases at four checks each, less the vacuous `wiredActions` on
    // each screen (nothing to press): vendo ran both and lost two checks on one,
    // diy ran one of the two and held everything on it.
    expect(html).toContain(`<tr><th>table</th><td>2</td><td class="no">4/6 · 2 vacuous</td><td class="ok">3/3 · 1 vacuous</td></tr>`);
    // Only vendo ran the chart case, so diy's cell says so rather than scoring it.
    expect(html).toContain(`<tr><th>chart</th><td>1</td><td class="ok">3/3 · 1 vacuous</td><td class="muted">—</td></tr>`);
    // Shapes nobody ran are not rows at all.
    expect(html).not.toContain(`<th>form</th>`);
  });

  /**
   * The one aggregate on this page, and it was adding up bare booleans — so a
   * screen with nothing to press scored full marks here, on a check that was
   * never in front of it, while the column below was already muting it as
   * unearned. A cell that disagrees with the card under it is worse than no cell.
   */
  /**
   * The table that says WHICH disease a column has.
   *
   * Every other total on this page is a sum over all four checks, so a contender
   * whose pages never compiled and a contender whose buttons are dead read as the
   * same figure. Six columns instead: the three every screen is put to, and
   * `wiredActions` as the three questions it answers at once.
   */
  it("breaks each column's floor out per check, `wiredActions` into its three questions", async () => {
    const html = await preview(presses(), pressedWorlds(), ASKED_TO_ACT);

    expect(html).toContain(
      `<thead><tr><th>column</th><th>cases</th><th>delivered</th><th>renders</th><th>valid</th>` +
        `<th>pressed</th><th>wired</th><th>actionProven</th></tr></thead>`,
    );
    // Three screens: every control held, one of them named no tool at all — so
    // `wired` was never in front of it — and one was asked to act and never did.
    // One number could only ever have said `11/12`.
    expect(html).toContain(
      `<tr><th>vendo-sonnet</th><td>3</td><td class="ok">3/3</td><td class="ok">3/3</td><td class="ok">3/3</td>` +
        `<td class="ok">3/3</td><td class="ok">2/2 · 1 vacuous</td><td class="no">2/3</td></tr>`,
    );
    // Nobody asked the display column's screen to do anything, so its
    // `actionProven` cell is beside the totals rather than failed in them.
    expect(html).toContain(`<tr><th>diy-sonnet</th><td>1</td>`);
    expect(html).toContain(`<td class="muted">— · 1 vacuous</td>`);
  });

  it("keeps a vacuous check out of the shape table's numerator and its denominator", async () => {
    const html = await preview([resultFor("vendo-sonnet", "blank", "Show me nothing.")], { blank: world });

    // Three checks were really in front of it; the fourth had nothing to be.
    expect(html).toContain(`<td class="ok">3/3 · 1 vacuous</td>`);
    expect(html).not.toContain(`<td class="ok">4/4</td>`);
    // And the card's own header agrees with the table above it, to the digit.
    expect(html).toContain(`<span class="score ok">3/3 · 1 vacuous</span>`);
  });

  /**
   * Half the question this benchmark answers is time, and the page said it one
   * screen at a time — in a card the reader has to scroll to and add up by hand.
   * Three numbers, because one is not a duration: a column with a fast median
   * and a forty-second worst case is a different product from one without it.
   */
  it("prints each column's duration under its floor cells, in seconds", async () => {
    const timed = (contender: string, testCase: string, settledMs: number): CaseResult => ({
      ...resultFor(contender, testCase, "one"),
      timing: { settledMs },
    });
    const html = await preview(
      [
        timed("vendo-sonnet", "a", 2_000),
        timed("diy-sonnet", "a", 9_000),
        timed("vendo-sonnet", "b", 41_000),
        timed("diy-sonnet", "b", 9_000),
      ],
      { a: world, b: world },
    );

    expect(html).toContain(
      `<tr><th>duration</th><td class="muted">median · p90 · worst</td>` +
        `<td>2s · 41s · 41s</td><td>9s · 9s · 9s</td></tr>`,
    );
  });

  /**
   * The other row under the floor cells: whether a column's screens FOLLOWED the
   * host's data when it moved, or printed it once and stopped listening. A
   * screen that displayed none of the moved values is out of both halves of the
   * fraction and counted beside it, the way a vacuous check is everywhere else,
   * and a column nobody has measured at all says nothing rather than zero.
   */
  it("prints each column's liveness under its floor cells, with the unmeasurable screens beside it", async () => {
    const alive = (contender: string, testCase: string, liveness?: CaseResult["liveness"]): CaseResult => ({
      ...resultFor(contender, testCase, "one"),
      ...(liveness === undefined ? {} : { liveness }),
    });
    const html = await preview(
      [
        alive("vendo-sonnet", "a", { live: 2, displayed: 3 }),
        alive("diy-sonnet", "a"),
        alive("vendo-sonnet", "b", { live: 0, displayed: 0, vacuous: true }),
        alive("diy-sonnet", "b"),
      ],
      { a: world, b: world },
    );

    expect(html).toContain(
      `<tr><th>liveness</th><td class="muted">shown values that moved with the data</td>` +
        `<td>2/3 · 1 vacuous</td><td class="muted">—</td></tr>`,
    );
  });

  /**
   * The third row under the floor cells, and the one reading the floor cannot
   * give: the probe stops at a confirmation on purpose, so a screen that opens
   * a dialog and a screen that really calls the host's write BOTH clear
   * `wiredActions` — and they are not the same product. Off the bindings
   * already saved: nothing is probed, judged or scored again.
   */
  it("says how far each column's action screens got — a write, a confirmation, or nothing", async () => {
    const html = await preview(presses(), pressedWorlds(), ASKED_TO_ACT);

    // Of the three cases that ASKED, one reached `cancel_transfer`, one got as
    // far as the dialog, and one only ever read. The column with no action case
    // at all says nothing rather than 0/0.
    expect(html).toContain(
      `<tr><th>writes</th><td class="muted">action cases whose presses called a write tool</td>` +
        `<td>1/3 · 1 dialog</td><td class="muted">—</td></tr>`,
    );
  });

  /**
   * The same row, on the flow that has a SECOND step in the page rather than in a
   * dialog. The probe walks the controls a press reveals, so that step's write is
   * a path on the trace and never a binding — and read off the bindings alone the
   * screens that had this right read as `none`, the worst reading on the row. The
   * floor is the real grader's here, so the cell and its `acted` are two readings
   * of one trace.
   */
  it("counts a write one press inside an inline reveal as a write, not as nothing", async () => {
    const graded = pressed("vendo-sonnet", "cancel-transfer", [
      {
        label: "Cancel transfer",
        changed: true,
        calls: [],
        revealed: [
          { label: "Keep it", changed: true, calls: [] },
          { label: "Confirm", changed: true, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
        ],
      },
    ]);
    const html = await preview([graded], { "cancel-transfer": world }, new Set(["cancel-transfer"]));

    expect(graded.floor.wiredActions.acted).toBe("revealed");
    expect(html).toContain(
      `<tr><th>writes</th><td class="muted">action cases whose presses called a write tool</td><td>1/1</td></tr>`,
    );
  });

  /** And the same row when that inline step ENDS in a confirmation — the
   *  `capacity-rebalance` shape, whose write is the Modal's own button two presses
   *  in. The probe walks that dialog (2026-08-18), so the cell has to read as far
   *  as the floor does or a flow the floor calls proven reads here as one that
   *  reached nothing. */
  it("counts a write inside the confirmation an inline reveal opened", async () => {
    const graded = pressed("vendo-sonnet", "cancel-transfer", [
      {
        label: "Hand off",
        changed: true,
        calls: [],
        revealed: [
          { label: "Pick an assignee", changed: true, calls: [] },
          {
            label: "Confirm",
            changed: true,
            dialog: "Reassign this issue?",
            calls: [],
            inside: [
              { label: "✕", changed: true, calls: [] },
              { label: "Reassign", changed: true, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
            ],
          },
        ],
      },
    ]);
    const html = await preview([graded], { "cancel-transfer": world }, new Set(["cancel-transfer"]));

    expect(graded.floor.wiredActions.acted).toBe("revealed");
    expect(html).toContain(
      `<tr><th>writes</th><td class="muted">action cases whose presses called a write tool</td><td>1/1</td></tr>`,
    );
  });

  /** The row needs to be told which cases asked, because no `result.json` says
   *  it — and a run whose world folder has moved since loses the row the way it
   *  loses the data panel, rather than reporting a zero nobody earned. */
  it("says nothing at all when nothing could tell it which cases asked", async () => {
    const html = await preview(presses(), pressedWorlds());

    expect(html).toContain(`<tr><th>writes</th><td class="muted">action cases whose presses called a write tool</td>` +
      `<td class="muted">—</td><td class="muted">—</td></tr>`);
  });

  /** A run that never asked a judge has no verdicts to print, and says which
   *  silence it is: a column whose rubric is simply missing reads as a report
   *  that lost it. */
  it("marks a floor-only screen where its verdicts would be, and prints no tally", async () => {
    const html = await preview(
      [{ ...resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."), judged: unjudged }],
      { "pending-transfers": world },
    );

    expect(html).toContain("floor only — no judge was asked about this screen");
    expect(html).not.toContain(`<span>the ask</span>`);
    // Not the grader having a bad afternoon — nobody was asked.
    expect(html).not.toContain("judge degraded");
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
        { label: "Details", changed: true, calls: [] },
        { label: "Refresh", changed: false, calls: [] },
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

  /** An `action` case can fail `wiredActions` while every press on it holds, so
   *  the check's own reason has to be readable beside them or the column shows a
   *  red mark over a row of green ticks. */
  it("prints why an action case failed when no single press did", async () => {
    const unproven = wiredActions([{ label: "Details", changed: true, calls: [] }], world, ["action"]);
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

  /** The two readings of a `wiredActions` pass: a screen with nothing to press
   *  passes without one control having been proven live. */
  it("tells a screen whose controls all held apart from one with nothing to press", async () => {
    const live = wiredActions(
      [
        { label: "Cancel", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
        { label: "Details", changed: true, calls: [] },
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
  const summaryOf = async (
    results: readonly CaseResult[],
    against?: { worlds: Record<string, World>; actionCases: ReadonlySet<string> },
  ): Promise<RunSummary> => {
    const runDir = await mkdtemp(join(tmpdir(), "genbench-summary-"));
    const path = await writeSummary({ runDir, runId: "run-1", results, gitSha: "0".repeat(40), ...against });
    return JSON.parse(await readFile(path, "utf8")) as RunSummary;
  };

  it("adds one column's floor cells up, keeping a vacuous one out of both halves", async () => {
    const summary = await summaryOf([
      resultFor("vendo-sonnet", "a", "one"),
      { ...resultFor("vendo-sonnet", "b", "two"), floor: { ...PASSING, renders: false, pass: false } },
      { ...resultFor("vendo-sonnet", "c", "three"), floor: CONTROLS_HELD },
    ]);

    // Three screens: 3 graded cells each on the first two, whose `wiredActions`
    // had nothing to press, and all 4 on the one whose controls held.
    expect(summary.columns["vendo-sonnet"]!.floor).toEqual({ earned: 9, failed: 1, vacuous: 2, degraded: 0 });
    expect(summary.columns["vendo-sonnet"]!.cases).toBe(3);
  });

  /**
   * The same cells, one tally each — because one earned/failed sum cannot say
   * which disease a column has, and a compile crash and a dead button moved it by
   * the same amount.
   *
   * Off the REAL grader's bindings, and against the write axis's own fixture, so
   * the split and the row beside it are two readings of one set of evidence.
   */
  it("splits the floor per check, with `wiredActions` as the three questions it answers", async () => {
    const summary = await summaryOf(presses(), { worlds: pressedWorlds(), actionCases: ASKED_TO_ACT });
    const column = summary.columns["vendo-sonnet"]!;

    expect(column.floorChecks).toEqual({
      delivered: { earned: 3, failed: 0, vacuous: 0 },
      renders: { earned: 3, failed: 0, vacuous: 0 },
      valid: { earned: 3, failed: 0, vacuous: 0 },
      // Every control the probe pressed did something.
      pressed: { earned: 3, failed: 0, vacuous: 0 },
      // The screen whose only press opened a confirmation named no tool, so there
      // was nothing on it to recognise or validate.
      wired: { earned: 2, failed: 0, vacuous: 1 },
      // …and that same screen is the one asked to act that never proved it.
      actionProven: { earned: 2, failed: 1, vacuous: 0 },
    });
    // The total it splits does not move, and is not these added up: that screen
    // missed one question and is still one failed `wiredActions` cell.
    expect(column.floor).toEqual({ earned: 11, failed: 1, vacuous: 0, degraded: 0 });
  });

  /** A bar nobody set is not a bar a column failed: no case here asked its screen
   *  to act, so that cell sits beside the totals exactly as a screen with nothing
   *  to press sits beside `pressed`. */
  it("keeps the action cell out of a column nobody asked to act", async () => {
    const summary = await summaryOf([resultFor("vendo-sonnet", "a", "one")]);

    expect(summary.columns["vendo-sonnet"]!.floorChecks["actionProven"]).toEqual({
      earned: 0,
      failed: 0,
      vacuous: 1,
    });
    expect(summary.columns["vendo-sonnet"]!.floorChecks["pressed"]).toEqual({ earned: 0, failed: 0, vacuous: 1 });
  });

  it("counts rubric lines by half, so an `na` on a case line is not a line that vanished", async () => {
    const summary = await summaryOf([resultFor("vendo-sonnet", "a", "one")]);

    expect(summary.columns["vendo-sonnet"]!.caseLines).toEqual({ pass: 1, fail: 1, na: 0 });
    expect(summary.columns["vendo-sonnet"]!.styleLines).toEqual({ pass: 1, fail: 0, na: 1 });
  });

  it("counts the standing honesty line on its own, and out of the case's own", async () => {
    const summary = await summaryOf([resultFor("vendo-sonnet", "a", "one")]);

    expect(summary.columns["vendo-sonnet"]!.honesty).toEqual({ pass: 1, fail: 0, flipped: 0, unadjudicated: 0 });
    // Two authored case lines, and the standing one is in neither other half.
    expect(summary.columns["vendo-sonnet"]!.caseLines).toEqual({ pass: 1, fail: 1, na: 0 });
  });

  /** A screen either showed honest numbers or it did not, so an unanswered
   *  honesty line is not a line that had no subject — it is counted the way
   *  `tally` counts an `na` on any case line, as a fail. */
  it("counts an `na` on the honesty line as a fail rather than a bucket of its own", async () => {
    const unanswered: JudgeResult = {
      lines: JUDGED.lines.map((line) =>
        line.line === HONESTY_LINE ? { ...line, verdict: "na" as const, note: "no numbers found" } : line,
      ),
      degraded: false,
    };
    const summary = await summaryOf([resultFor("vendo-sonnet", "a", "one", unanswered)]);

    expect(summary.columns["vendo-sonnet"]!.honesty).toEqual({ pass: 0, fail: 1, flipped: 0, unadjudicated: 0 });
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
    });
    expect(summary.models).toContain("claude-sonnet-5");
  });

  /** The other half of buy-versus-build, and it had no aggregate anywhere: 200
   *  cases wrote 200 timings and no total. Nearest rank, so every number here is
   *  a case that really ran rather than the mean of two that did not. */
  it("says how long a column took as the middle case and the tail behind it", async () => {
    const summary = await summaryOf(
      [7, 2, 9, 1, 4, 10, 3, 8, 5, 6].map((seconds, index) => ({
        ...resultFor("vendo-sonnet", `case-${index}`, "one"),
        timing: { settledMs: seconds * 1_000, firstRenderMs: seconds * 100 },
      })),
    );

    expect(summary.columns["vendo-sonnet"]!.settledMs).toEqual({ median: 5_000, p90: 9_000, worst: 10_000 });
    expect(summary.columns["vendo-sonnet"]!.firstRenderMedianMs).toBe(500);
  });

  it("says nothing about a first render for a column that never reported one", async () => {
    const summary = await summaryOf([{ ...resultFor("vendo-sonnet", "a", "one"), timing: { settledMs: 2_000 } }]);

    expect(summary.columns["vendo-sonnet"]!.firstRenderMedianMs).toBeUndefined();
    expect(summary.columns["vendo-sonnet"]!.settledMs).toEqual({ median: 2_000, p90: 2_000, worst: 2_000 });
  });

  /** The same evidence the page's write row is read from, added up per column —
   *  so a 200-case sweep can answer "how many of the screens we asked to act
   *  actually reached the host's write side" without opening the page. */
  it("adds a column's action cases up by how far its presses got", async () => {
    const summary = await summaryOf(presses(), { worlds: pressedWorlds(), actionCases: ASKED_TO_ACT });

    expect(summary.columns["vendo-sonnet"]!.actions).toEqual({ write: 1, dialog: 1, none: 1 });
    // The display case's press reached a write and is still in nobody's count.
    expect(summary.columns["diy-sonnet"]!.actions).toEqual({ write: 0, dialog: 0, none: 0 });
  });

  /** A skipped exam is a fact about the RUN, so it must not land on a column as
   *  failed lines — which is what the `ungraded` shape would have done. */
  it("counts a floor-only screen's rubric as nothing at all, in every half", async () => {
    const summary = await summaryOf([{ ...resultFor("vendo-sonnet", "a", "one"), judged: unjudged }]);

    expect(summary.columns["vendo-sonnet"]!.caseLines).toEqual({ pass: 0, fail: 0, na: 0 });
    expect(summary.columns["vendo-sonnet"]!.honesty).toEqual({ pass: 0, fail: 0, flipped: 0, unadjudicated: 0 });
    expect(summary.columns["vendo-sonnet"]!.styleLines).toEqual({ pass: 0, fail: 0, na: 0 });
    expect(summary.columns["vendo-sonnet"]!.judgeDegraded).toBe(0);
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
