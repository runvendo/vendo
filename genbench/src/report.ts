import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checks, holds, splitChecks, type Binding, type Check, type WiredActionsResult } from "./floor.js";
import { HONESTY_LINE, type JudgeResult, type LineVerdict, type Verdict } from "./judge.js";
import type { UsageTotals } from "./meter.js";
import type { Fired } from "./probe.js";
import { VIEWPORT } from "./render.js";
import type { CaseResult } from "./run.js";
import { cannedResponse, type World } from "./world.js";

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const verdict = (ok: boolean): string =>
  `<span class="v ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${ok ? "pass" : "fail"}</span>`;

/** `wiredActions`'s own verdict: a fail reads exactly as any other failing check
 *  does, but a pass splits in two. A screen with nothing to press passes without
 *  a single control having been proven live, and that must not wear the
 *  checkmark a screen full of working controls earned. */
const wiredActionsVerdict = (actions: WiredActionsResult): string => {
  if (!actions.pass) return verdict(false);
  if (actions.pressed === 0) return `<span class="v muted">— nothing to press</span>`;
  return `<span class="v ok">✓ · ${actions.pressed} control${actions.pressed === 1 ? "" : "s"} pressed</span>`;
};

/** Every small list under a verdict — bindings, blocking findings — is this
 *  list. */
const notes = (rows: readonly string[]): string => `<ul class="notes">${rows.join("")}</ul>`;

/** One row per press, under the mark the floor gave it. The row's words are the
 *  binding's own `why` — which is what makes a state-only pass readable as a pass
 *  and not as a control nobody could explain. */
const bindingList = (actions: WiredActionsResult): string =>
  notes([
    // The check's own reason, where it failed for something no single press
    // did: an action case with nothing but live local state on it reads as a
    // red mark over a column of green ticks otherwise.
    ...(actions.why === undefined ? [] : [`<li><span>${escape(actions.why)}</span> <i class="no">✕</i></li>`]),
    ...(actions.bindings.length === 0
      ? ["<li><span>nothing on this screen to press</span></li>"]
      : actions.bindings.map(
          (b) =>
            `<li><code>${escape(b.where)}</code> <span>${[b.tool, b.why]
              .filter((part) => part !== undefined)
              .map(escape)
              .join(" — ")}</span> ${holds(b) ? '<i class="ok">✓</i>' : '<i class="no">✕</i>'}</li>`,
        )),
  ]);

/** `renders` can fail for a reason no screenshot shows, so the reason is on the
 *  page next to the verdict. */
const consoleNote = (errors: readonly string[]): string =>
  errors.length === 0
    ? ""
    : `<p class="warn">${errors.length} console error${errors.length === 1 ? "" : "s"} while painting: ${escape(errors[0]!)}</p>`;

const metric = (label: string, value: string): string =>
  `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`;

/** Never colour alone: the mark says which verdict this is in grayscale, to a
 *  screen reader, and to anyone who does not see red and green apart. */
const MARK: Readonly<Record<Verdict, string>> = { pass: "✓", fail: "✕", na: "–" };

/**
 * `na` means the line's subject is not on this screen at all — but only a DESIGN
 * line may honestly say so. A design line describes the product's look, and a
 * screen with nothing destructive on it neither earned nor missed a line about
 * confirming deletions, so counting it would grade a screen for lacking
 * something it was never asked to have.
 *
 * A CORRECTNESS line is the case itself: it is what this screen was asked to do,
 * and a screen the judge can find no subject for did not do it. Excluding those
 * shrank the denominator, so omitting a feature outscored building it
 * imperfectly, and two columns of one case were scored out of two different
 * totals — which is the one thing a comparison cannot survive.
 *
 * One definition, exported, because the run prints this on the terminal too —
 * two denominators for one score is a benchmark arguing with itself.
 */
export const tally = (lines: readonly LineVerdict[]): string => {
  const graded = lines.filter((line) => line.source === "case" || line.verdict !== "na");
  return `${graded.filter((line) => line.verdict === "pass").length}/${graded.length}`;
};

/**
 * Which part of the rubric a line belongs to — three of them, where the page
 * used to read two.
 *
 * "Did this screen show what was asked" and "are the numbers on it real" are
 * different things to know about a contender, and the standing honesty line
 * answered the second inside the first's score: a screen that invented a figure
 * and a screen that missed a row moved one number by the same amount, and
 * neither said which had happened. The split is mechanical — honesty is the one
 * case line no case is authored with.
 *
 * `half` stays the word because it is what the page's own rows are called.
 */
type Half = "correctness" | "honesty" | "design";

const halfOf = (line: LineVerdict): Half =>
  line.source === "style" ? "design" : line.line === HONESTY_LINE ? "honesty" : "correctness";

const inHalf = (lines: readonly LineVerdict[], half: Half): LineVerdict[] =>
  lines.filter((line) => halfOf(line) === half);

/** One half of the rubric, its lines in the order they were asked, each under
 *  the evidence the judge named — on the page, not behind a hover, because an
 *  unarguable verdict is one you cannot check. */
const rubricHalf = (label: string, lines: readonly LineVerdict[], degraded: boolean): string =>
  lines.length === 0
    ? ""
    : `<div class="half">
    <p class="half-head"><span>${label}</span><b>${degraded ? "—" : tally(lines)}</b></p>
    <ul class="lines">${lines
      .map(
        (line) =>
          `<li class="${line.verdict}"><i aria-hidden="true">${MARK[line.verdict]}</i><span class="what">` +
          `<span class="line">${escape(line.line)}</span>` +
          `<span class="note">${escape(line.verdict)} — ${escape(line.note)}</span></span></li>`,
      )
      .join("")}</ul>
  </div>`;

/**
 * The judge's half of the score. The case's `pass` lines are correctness, the
 * standing honesty line is its own row beside them, the world's `style` lines
 * are design, and each verdict carries the evidence it was reached on.
 *
 * A degraded judgement is the GRADER having a bad afternoon, not the contender
 * failing, so it says so at the top and prints no tally: every line reads
 * `fail` in that state, and "0/2" beside a column is a sentence about the
 * contender that would not be true.
 *
 * A rubric with NO lines is a third thing again: a run that never asked a judge
 * (`--floor-only`). It says so rather than printing nothing, because a column
 * whose verdicts are simply missing reads as a report that lost them.
 */
// "the ask" is the human-facing label only (2026-08-18) — "correctness" stays
// the internal half above and the judge's own prompt tag in judge.ts.
const rubric = (judged: JudgeResult): string =>
  judged.lines.length === 0
    ? `<p class="unjudged">floor only — no judge was asked about this screen</p>`
    : `<section class="rubric">
  ${
    judged.degraded
      ? `<p class="degraded">judge degraded — this screen was not graded${judged.error === undefined ? "" : `: ${escape(judged.error)}`}</p>`
      : ""
  }
  ${rubricHalf("the ask", inHalf(judged.lines, "correctness"), judged.degraded)}
  ${rubricHalf("honesty", inHalf(judged.lines, "honesty"), judged.degraded)}
  ${rubricHalf("design", inHalf(judged.lines, "design"), judged.degraded)}
</section>`;

/**
 * A screen's floor score, with the cells that were never in front of it left
 * out of both halves and named beside them.
 *
 * One reader for the column header and for the shape table, so the total on a
 * card and the total in the table above it can only disagree by being different
 * sets of screens.
 */
const earned = (
  scored: ReadonlyArray<{ pass: boolean; vacuous?: true; degraded?: true }>,
): { passed: number; of: number; aside: string } => {
  const graded = scored.filter((check) => check.vacuous !== true && check.degraded !== true);
  const count = (kind: "vacuous" | "degraded"): string => {
    const many = scored.filter((check) => check[kind] === true).length;
    return many === 0 ? "" : ` · ${many} ${kind}`;
  };
  return {
    passed: graded.filter((check) => check.pass).length,
    of: graded.length,
    aside: count("vacuous") + count("degraded"),
  };
};

/** A set of cells as both tables print them: earned out of what was really in
 *  front of the screens, with what was not counted beside it. Nothing graded in
 *  it is muted rather than 0/0 — green on a question nobody put a column to is a
 *  claim about that column nobody tested. */
const scoreCell = (scored: readonly Check[]): string => {
  const { passed, of, aside } = earned(scored);
  return of === 0
    ? `<td class="muted">—${escape(aside)}</td>`
    : `<td class="${passed === of ? "ok" : "no"}">${passed}/${of}${escape(aside)}</td>`;
};

/**
 * Whether a case asked its screen to DO something — `action` in `cases.json`.
 *
 * The corpus answers wherever it still holds the case. Where it does not, the
 * floor's own `why` does: only an `action` case is ever given one. Without that
 * fallback a case whose world has moved would take `actionProven` out of the
 * totals while the `wiredActions` verdict above it still failed on that very
 * line, and the split would stop adding up to the check it splits.
 */
const askedToAct = (result: CaseResult, actionCases: ReadonlySet<string>): boolean =>
  actionCases.has(result.case) || result.floor.wiredActions.why !== undefined;

/** One column's floor cells, split, in the order `splitChecks` asks them. */
const splitOf = (rows: readonly CaseResult[], actionCases: ReadonlySet<string>): readonly Check[] =>
  rows.flatMap((row) => splitChecks(row.floor, askedToAct(row, actionCases)));

async function column(runDir: string, result: CaseResult): Promise<string> {
  const caseDir = join(result.contender, result.case);
  const shot = await readFile(join(runDir, caseDir, "screenshot.png")).catch(() => undefined);
  // Only whether it is there: the frame below loads it from disk itself.
  const hasPage = existsSync(join(runDir, caseDir, "page.html"));
  const scored = checks(result.floor);
  const { passed, of, aside } = earned(scored);
  const { usage } = result.cost;
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

  return `<section class="col">
  <header>
    <div><h2>${escape(result.contender)}</h2><p>${escape(result.model)}</p></div>
    <span class="score ${passed === of ? "ok" : "no"}">${passed}/${of}${escape(aside)}</span>
  </header>
  <figure>${
    hasPage
      ? `<iframe data-contender="${escape(result.contender)}" title="${escape(result.case)} as ${escape(result.contender)} built it" src="${escape(caseDir)}/page.html" loading="lazy"></iframe>`
      : `<div class="blank">nothing rendered</div>`
  }</figure>
  ${
    shot === undefined
      ? ""
      : `<div class="judge"><img alt="the screenshot ${escape(result.case)} was scored from"
        src="data:image/png;base64,${shot.toString("base64")}"><p>what the judge saw</p></div>`
  }
  ${result.failure === undefined ? "" : `<p class="failure">${escape(result.failure)}</p>`}
  ${consoleNote(result.consoleErrors)}
  <dl class="floor">${scored
    .map((check) => {
      const shown =
        check.name === "wiredActions" ? wiredActionsVerdict(result.floor.wiredActions) : verdict(check.pass);
      return `<div><dt>${check.name}</dt><dd>${shown}</dd></div>`;
    })
    .join("")}</dl>
  ${result.floor.blocking.length === 0 ? "" : notes(result.floor.blocking.map((why) => `<li><span>${escape(why)}</span></li>`))}
  ${bindingList(result.floor.wiredActions)}
  ${rubric(result.judged)}
  <dl class="metrics">
    ${metric("first render", result.timing.firstRenderMs === undefined ? "—" : `${result.timing.firstRenderMs} ms`)}
    ${metric("settled", `${result.timing.settledMs} ms`)}
    ${metric("tokens", tokens.toLocaleString("en-US"))}
    ${metric("cost", `$${result.cost.usd.toFixed(4)}`)}
  </dl>
</section>`;
}

/**
 * What one of the benchmark's OWN models cost, on its own line and in nobody's
 * column.
 *
 * The judge is the benchmark's overhead, not a contender's bill: folding it into
 * a `cost` figure would quietly make every column more expensive than the thing
 * it measures, and two runs graded a different number of times would stop
 * comparing. So it is said here, once, and left out of every column.
 */
const spendLine = (
  who: string,
  did: string,
  priced: ReadonlyArray<{ usage: UsageTotals; usd: number }>,
): string => {
  if (priced.length === 0) return "";
  const tokens = priced.reduce(
    (total, { usage }) =>
      total + usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    0,
  );
  const usd = priced.reduce((total, cost) => total + cost.usd, 0);
  return `<p class="meta spend"><span>${who} · ${priced.length} screen${priced.length === 1 ? "" : "s"} ${did}</span>` +
    `<span>${tokens.toLocaleString("en-US")} tokens</span><span>$${usd.toFixed(4)}</span>` +
    `<span>not counted in any contender's cost</span></p>`;
};

/**
 * What the floor FOUND, per check — the reading one number cannot give.
 *
 * Every other total on this page is a sum over all four checks, so a contender
 * whose pages never compiled and a contender whose buttons are dead read as the
 * same figure and a person cannot tell which disease they are looking at. These
 * are those same verdicts, unsummed: the three checks every screen is put to, and
 * `wiredActions` as the three questions it answers at once (`splitChecks` in
 * `floor.ts`).
 *
 * A column per check and a row per contender, because it is the other way round
 * that does not fit: seven contenders times six checks is a table nobody can
 * read. Nothing is decided again here — a cell earned, missed, or never in front
 * of a screen is the one the card below says it is, and the columns are named in
 * the vocabulary `summary.json` uses so the page and the file cannot drift.
 */
const checkTable = (results: readonly CaseResult[], actionCases: ReadonlySet<string>): string => {
  if (results.length === 0) return "";
  const contenders = [...new Set(results.map((result) => result.contender))];
  const names = [...new Set(splitOf(results, actionCases).map((check) => check.name))];
  return `<table class="shapes">
  <thead><tr><th>column</th><th>cases</th>${names.map((name) => `<th>${escape(name)}</th>`).join("")}</tr></thead>
  <tbody>${contenders
    .map((contender) => {
      const rows = results.filter((result) => result.contender === contender);
      const cells = splitOf(rows, actionCases);
      return `<tr><th>${escape(contender)}</th><td>${rows.length}</td>${names
        .map((name) => scoreCell(cells.filter((check) => check.name === name)))
        .join("")}</tr>`;
    })
    .join("")}</tbody>
</table>`;
};

/**
 * The run's floor score by shape — the only place on this page a contender's
 * screens are added up at all. Every column below is a single screen, so a
 * contender that holds the floor everywhere except charts says so here and
 * nowhere else.
 *
 * The cells are the columns' OWN checks, summed: `checks` is the same function
 * `column` scores with, so a cell can never disagree with the columns beneath it
 * except by being their total. A shape nobody ran a case for is muted rather
 * than scored, for the reason a vacuous `wiredActions` pass is — 0/0 painted
 * green is a claim about a contender that was never put to the test.
 *
 * And a vacuous check is out of the numerator AND the denominator, counted
 * beside them instead. Summing bare booleans is how a blank page — nothing to
 * press — scored full marks here while the preview under it was already muting
 * that cell as unearned.
 */
const shapeTable = (
  results: readonly CaseResult[],
  worlds: Readonly<Record<string, World>>,
  actionCases: ReadonlySet<string>,
): string => {
  if (results.length === 0) return "";
  const shapes = [...new Set(results.map((result) => result.shape))].sort();
  // First-seen, so the cells read left to right in the column order below.
  const contenders = [...new Set(results.map((result) => result.contender))];
  const cell = (rows: readonly CaseResult[]): string => scoreCell(rows.flatMap((row) => checks(row.floor)));
  return `<table class="shapes">
  <thead><tr><th>shape</th><th>cases</th>${contenders
    .map((contender) => `<th>${escape(contender)}</th>`)
    .join("")}</tr></thead>
  <tbody>${shapes
    .map((shape) => {
      const rows = results.filter((result) => result.shape === shape);
      return `<tr><th>${escape(shape)}</th><td>${new Set(rows.map((row) => row.case)).size}</td>${contenders
        .map((contender) => cell(rows.filter((row) => row.contender === contender)))
        .join("")}</tr>`;
    })
    .join("")}</tbody>
  <tfoot>${durationRow(results, contenders)}${livenessRow(results, contenders)}${writesRow(results, contenders, worlds, actionCases)}</tfoot>
</table>`;
};

/** Nearest rank, on a list that sorts itself: every number printed here is a
 *  case that really ran, never the mean of two that did not. */
const at = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
};

/**
 * How long a column took to answer, as the three numbers that describe one wait.
 *
 * Half the question this benchmark exists to answer is time, and one number is
 * not a duration: a column with a fast median and a two-minute worst case is a
 * different product from one without it. So the case a person should expect,
 * and the tail they will actually feel, are both said.
 */
export const durations = (
  results: readonly CaseResult[],
): { median: number; p90: number; worst: number } => {
  const settled = results.map((result) => result.timing.settledMs);
  return { median: at(settled, 0.5), p90: at(settled, 0.9), worst: at(settled, 1) };
};

/** The same three numbers, in the same columns as the floor cells above them, so
 *  a column's score and what it cost in time are read together. Whole seconds:
 *  a case here is one to four minutes, and a tenth of a second on a wait that
 *  long is precision the reader has to look past. The exact milliseconds are
 *  still on every case's own card. */
const durationRow = (results: readonly CaseResult[], contenders: readonly string[]): string => {
  const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
  return `<tr><th>duration</th><td class="muted">median · p90 · worst</td>${contenders
    .map((contender) => {
      const { median, p90, worst } = durations(results.filter((result) => result.contender === contender));
      return `<td>${seconds(median)} · ${seconds(p90)} · ${seconds(worst)}</td>`;
    })
    .join("")}</tr>`;
};

/**
 * How much of what a set of screens showed followed the data when the data
 * moved, added up — the aggregate the liveness row and `summary.json` both read.
 *
 * A screen that displayed none of the moved values is counted BESIDE the totals
 * rather than in them, for the reason a vacuous `wiredActions` pass is: it was
 * neither bound nor baked, and folding it in either direction is a claim about a
 * screen that was never put to the test. A case with no liveness at all — no
 * page painted, or a run recorded before the axis — is in none of the three.
 */
const bound = (results: readonly CaseResult[]): { live: number; displayed: number; vacuous: number } => {
  const measured = results.flatMap((result) => result.liveness ?? []);
  return {
    live: measured.reduce((total, one) => total + one.live, 0),
    displayed: measured.reduce((total, one) => total + one.displayed, 0),
    vacuous: measured.filter((one) => one.vacuous === true).length,
  };
};

/**
 * Whether a column's screens were bound to the host's data, in the same columns
 * as the floor cells above them, so what a screen scored and whether it would
 * survive the data changing are read together.
 *
 * Uncoloured, like the clock beside it and unlike every cell above: this is
 * REPORTED, not gated. Painting it green and red would read as a check the run
 * passed or failed, and no exit code has ever depended on it.
 */
const livenessRow = (results: readonly CaseResult[], contenders: readonly string[]): string =>
  `<tr><th>liveness</th><td class="muted">shown values that moved with the data</td>${contenders
    .map((contender) => {
      const { live, displayed, vacuous } = bound(results.filter((result) => result.contender === contender));
      const aside = vacuous === 0 ? "" : ` · ${vacuous} vacuous`;
      return displayed === 0
        ? `<td class="muted">—${escape(aside)}</td>`
        : `<td>${live}/${displayed}${escape(aside)}</td>`;
    })
    .join("")}</tr>`;

/**
 * How far one screen's presses actually got, read back off its own bindings.
 *
 * `wiredActions` says whether every press HELD; it never says whether any of
 * them reached the host's write side. A screen that opens a confirmation and a
 * screen that really calls `cancel_transfer` both clear that check — asking
 * first is a product decision, not a failure — and they are not the same
 * product. This is that third reading: a WRITE is a tool the world declares with
 * no canned data (`riskOf` in `world.ts`), a DIALOG is a press that opened a
 * confirmation and called no write, and NONE is neither. Nothing is probed,
 * judged or scored again — the bindings and the trace on disk are the whole
 * evidence, which is why a saved run gets this for free.
 *
 * A write one press inside an inline REVEAL is the screen's own write: "press
 * Hand off, pick an assignee, press Confirm" is one flow, and since the probe
 * walks what a press puts on the page (2026-08-18) those presses sit on the trace
 * as PATHS rather than as bindings — so read off the bindings alone the whole
 * flow counted as a dialog, or as nothing at all. Read the same way the dialog
 * reading is read: off the trace, and only for a tool the world calls a write.
 * Including the confirmation such a step ENDS in, since the probe walks that too
 * (2026-08-18) — the `capacity-rebalance` shape, whose write is the Modal's button
 * two presses in — because a flow the floor calls proven must not read as a flow
 * that reached nothing here.
 */
const reached = (result: CaseResult, world: World | undefined): "write" | "dialog" | "none" => {
  const writes = new Set(
    (world?.tools ?? []).filter((tool) => tool.descriptor.risk === "write").map((tool) => tool.name),
  );
  const called = (calls: readonly Fired[]): boolean => calls.some((call) => writes.has(call.name));
  const wrote = result.trace.some((probed) =>
    (probed.revealed ?? []).some((path) => called(path.calls) || (path.inside ?? []).some((deeper) => called(deeper.calls))));
  if (wrote || result.floor.wiredActions.bindings.some((binding) => binding.tool !== undefined && writes.has(binding.tool))) {
    return "write";
  }
  return result.trace.some((probed) => probed.dialog !== undefined) ? "dialog" : "none";
};

/** The same reading added up over the cases that ASKED for it — the only ones
 *  it means anything on, since a display screen was never told to write. A case
 *  whose world has moved since is counted as having reached nothing rather than
 *  left out: its writes cannot be named any more, and that is the report's
 *  loss, not the column's. */
const acted = (
  results: readonly CaseResult[],
  worlds: Readonly<Record<string, World>>,
  actionCases: ReadonlySet<string>,
): { write: number; dialog: number; none: number } => {
  const far = { write: 0, dialog: 0, none: 0 };
  for (const result of results) {
    if (actionCases.has(result.case)) far[reached(result, worlds[result.case])] += 1;
  }
  return far;
};

/**
 * Whether a column's ACTION screens reached the host's write side, in the same
 * columns as the floor cells above them — so what a screen scored and how far
 * pressing it really got are read together.
 *
 * Uncoloured, like the clock and the liveness row beside it: this is REPORTED,
 * never gated, and no exit code has ever depended on it. A column with no
 * action case says nothing rather than 0/0.
 */
const writesRow = (
  results: readonly CaseResult[],
  contenders: readonly string[],
  worlds: Readonly<Record<string, World>>,
  actionCases: ReadonlySet<string>,
): string =>
  `<tr><th>writes</th><td class="muted">action cases whose presses called a write tool</td>${contenders
    .map((contender) => {
      const { write, dialog, none } = acted(
        results.filter((result) => result.contender === contender),
        worlds,
        actionCases,
      );
      const asked = write + dialog + none;
      const aside = dialog === 0 ? "" : ` · ${dialog} dialog`;
      return asked === 0 ? `<td class="muted">—</td>` : `<td>${write}/${asked}${escape(aside)}</td>`;
    })
    .join("")}</tr>`;

const spent = <T,>(results: readonly CaseResult[], of: (result: CaseResult) => T | undefined): T[] =>
  results.flatMap((result) => {
    const cost = of(result);
    return cost === undefined ? [] : [cost];
  });

/** The case's own truth, collapsed: every tool the screens could call, what it
 *  does, and the exact response it answers with — case overrides applied. It is
 *  what makes any number on any screen above checkable by eye. */
function worldPanel(world: World | undefined): string {
  if (world === undefined) return "";
  const tools = world.tools
    .map(
      (tool) => `<div class="tool">
      <p><code>${escape(tool.name)}</code> ${escape(tool.descriptor.description ?? "")}</p>
      <pre>${escape(JSON.stringify(cannedResponse(tool), null, 2))}</pre>
    </div>`,
    )
    .join("");
  return `<details class="world">
  <summary><span class="chev">▸</span>World data · ${world.tools.length} tools · the only numbers these screens may show</summary>
  <div class="tools">${tools}</div>
</details>`;
}

/** Where the question was found, for the two thirds of cases that were mined
 *  from a real screen: the URLs are linked so the screen is one click away, and
 *  a case nobody mined prints nothing rather than an empty line. */
const sourceLine = (source: string | undefined): string =>
  source === undefined
    ? ""
    : `<p class="source">from ${escape(source).replace(/https?:\/\/[^\s;]+/g, (url) => `<a href="${url}">${url}</a>`)}</p>`;

async function caseSection(runDir: string, testCase: string, results: readonly CaseResult[], world: World | undefined): Promise<string> {
  const columns = await Promise.all(results.map(async (result) => await column(runDir, result)));
  return `<section class="case">
  <p class="case-id">${escape(testCase)}</p>
  <h2 class="prompt">${escape(results[0]?.prompt ?? "")}</h2>
  ${sourceLine(results[0]?.source)}
  ${worldPanel(world)}
  <div class="grid">${columns.join("")}</div>
</section>`;
}

const CSS = `
:root{--ink:#17171a;--sec:#5c5c66;--ter:#8e8e99;--page:#f6f5f3;--card:#fff;--line:#e6e4e0;--ok:#1d7a4f;--no:#b4342a;--feed:136px;}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);
  font:450 15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;border-top:3px solid var(--ink);}
/* Room for the fixed call feed, so the last column is never hidden under it.
   The width cap here is just a sane page width — each iframe caps itself at
   VIEWPORT's own width below, so this isn't what keeps a screen life-sized. */
.wrap{max-width:1560px;margin:0 auto;padding:32px 24px calc(var(--feed) + 32px)}
h1{margin:0;font-size:28px;font-weight:600;letter-spacing:-.02em}
.meta{margin:16px 0 0;font:450 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.meta span+span::before{content:"·";margin:0 8px;color:var(--line)}
/* The run's own overhead, tucked under the run line it belongs to rather than
   given a panel: it is a fact about the benchmark, not a result. */
.meta.spend{margin-top:6px}
/* ---- the run's scoreboard by shape: the columns' own checks, added up ---- */
.shapes{width:100%;margin:20px 0 0;border-collapse:collapse;overflow:hidden;background:var(--card);
  border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05)}
.shapes th,.shapes td{padding:9px 16px;text-align:right;border-bottom:1px solid var(--line);
  font:450 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.shapes th:first-child{text-align:left}
.shapes thead th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.shapes tbody th{font-weight:600;color:var(--ink)}
.shapes tbody tr:last-child th,.shapes tbody tr:last-child td{border-bottom:0}
/* What is measured beside the score rather than scored — the clock, and whether
   the screens were bound to the data — ruled off under the cells they belong to:
   same columns, so a column's floor and what it cost in time and in binding are
   read in one glance. */
.shapes tfoot th,.shapes tfoot td{border-top:1px solid var(--line);border-bottom:0}
.shapes .muted{color:var(--ter)}
/* The prompt is the heading a person reads; the case id is a filename. */
.case{margin-top:48px}
.case-id{margin:0;font:450 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.prompt{margin:10px 0 0;font-size:20px;font-weight:500;line-height:1.35;letter-spacing:-.01em;max-width:62ch}
/* Provenance, never a score: quieter than the prompt it sits under. */
.source{margin:6px 0 0;font-size:12px;color:var(--ter);max-width:62ch}
.source a{color:inherit}
/* One contender per row. Three abreast used to fit each iframe into a
   360-540px box, but the grading frame is VIEWPORT below (1280x900) —
   squeezed that narrow, a contender's page reflows into a layout nobody's
   screen actually shows, so the preview stops resembling what the judge
   saw. Stacking leaves the iframe room to sit at (up to) its own graded
   width. */
.grid{display:grid;grid-template-columns:1fr;gap:24px;margin-top:24px}
.col{background:var(--card);border-radius:10px;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05)}
.col>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
h2{margin:0;font-size:15px;font-weight:600}
.col>header p{margin:2px 0 0;font-size:12px;color:var(--ter)}
.score{font:600 13px/1 ui-monospace,Menlo,monospace;padding:5px 8px;border-radius:6px}
.score.ok{color:var(--ok);background:#e8f3ed}.score.no{color:var(--no);background:#fbeceb}
/* Full-bleed to the card's edges: the card's own padding was costing the
   embedded screen 40px of width, which is the difference between a contender's
   page fitting and its right-hand controls being clipped. The frame is capped
   at VIEWPORT's own width and shaped to its aspect ratio — the exact box the
   screenshot was shot in — and centered, so a monitor wide enough to fit it
   renders the contender's page at the size it was graded at. */
figure{margin:16px -20px 0;background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line);overflow:hidden}
iframe{display:block;width:100%;max-width:${VIEWPORT.width}px;aspect-ratio:${VIEWPORT.width}/${VIEWPORT.height};margin:0 auto;border:0;background:#fff}
.blank{padding:48px 16px;text-align:center;font-size:13px;color:var(--ter)}
/* The judge's evidence, not the artifact: small, captioned, and inlined so it
   survives the file being moved. The live page above it does not. */
.judge{display:flex;align-items:center;gap:10px;margin-top:10px}
.judge img{display:block;width:72px;max-height:88px;object-fit:cover;object-position:top;
  border:1px solid var(--line);border-radius:4px;background:var(--page)}
.judge p{margin:0;font:450 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.failure{margin:12px 0 0;font-size:13px;color:var(--no)}
.warn{margin:12px 0 0;padding:8px 10px;border-radius:6px;background:#fdf6e7;font-size:12px;color:#7a5a12}
dl{margin:0}dl>div{display:flex;align-items:baseline;justify-content:space-between}
.floor{margin-top:20px;border-top:1px solid var(--line)}
.floor>div{padding:7px 0;border-bottom:1px solid var(--line)}
.floor dt{font-size:13px;color:var(--sec)}
.v{font:600 13px/1 ui-monospace,Menlo,monospace}.ok{color:var(--ok)}.no{color:var(--no)}
/* A vacuous pass: there was nothing to press, so no control was ever proven
   live. Same weight as the labels around it, never the green a real pass earns. */
.v.muted{color:var(--ter);font-weight:450}
.notes{margin:10px 0 0;padding:0;list-style:none}
.notes li{display:flex;gap:8px;align-items:baseline;padding:4px 0;font-size:12px;color:var(--ter)}
.notes code{font:450 12px/1.4 ui-monospace,Menlo,monospace;color:var(--ink);background:var(--page);padding:1px 5px;border-radius:4px}
.notes i{margin-left:auto;font-style:normal}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.metrics>div{display:block}
.metrics dt{font:450 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.metrics dd{margin:6px 0 0;font:450 15px/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}

/* ---- the judge's half: one row per rubric line, its evidence underneath ---- */
.rubric{margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.half+.half{margin-top:16px}
.half-head{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 4px;
  font:450 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;
  text-transform:uppercase;color:var(--ter)}
.half-head b{font-weight:600;color:var(--sec);font-variant-numeric:tabular-nums}
.lines{margin:0;padding:0;list-style:none}
.lines li{display:flex;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}
.lines li:last-child{border-bottom:0}
.lines i{flex:none;width:11px;text-align:center;font:600 13px/1.45 ui-monospace,Menlo,monospace;font-style:normal}
.lines .what{min-width:0}
.lines .line{display:block;font-size:13px;line-height:1.45;color:var(--ink)}
.lines .note{display:block;margin-top:2px;font-size:12px;line-height:1.45;color:var(--ter)}
.lines .pass i{color:var(--ok)}
.lines .fail i{color:var(--no)}
/* na: the line's subject is not on this screen at all, so the row stays — a
   rubric with holes in it is not a rubric — and recedes. */
.lines .na i{color:var(--ter)}
.lines .na .line{color:var(--ter)}
/* The one red block on the page, and it is about the GRADER. */
.degraded{margin:0 0 12px;padding:9px 12px;border-left:3px solid var(--no);border-radius:0 6px 6px 0;
  background:#fbeceb;font-size:12px;font-weight:600;color:var(--no)}
/* No rubric at all: nobody was asked. Quiet and in the half-heads' own type,
   because it is a fact about the run and not a verdict on the column. */
.unjudged{margin:20px 0 0;padding-top:16px;border-top:1px solid var(--line);
  font:450 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;
  text-transform:uppercase;color:var(--ter)}

/* ---- the world panel: closed by default, because it is the reference you
       reach for, not the thing you came to look at ---- */
.world{margin:20px 0 0;background:var(--card);border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.world>summary{display:flex;align-items:center;gap:8px;padding:13px 16px;cursor:pointer;list-style:none;
  font:450 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;
  text-transform:uppercase;color:var(--sec)}
.world>summary::-webkit-details-marker{display:none}
.chev{display:inline-block;color:var(--ter);transition:transform 150ms ease-out}
.world[open] .chev{transform:rotate(90deg)}
.tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;padding:4px 16px 18px}
.tool p{margin:0;font-size:13px;line-height:1.5;color:var(--sec);max-width:58ch}
.tool code{font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
/* Uncapped on purpose: this panel exists so a person can check a number against
   the truth, and a scroll box that clips at row two reads as the whole answer. */
.tool pre{margin:8px 0 0;padding:10px 12px;background:var(--page);border-radius:6px;
  font:450 11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sec)}

/* ---- the call feed: every press in every embedded screen, as it happens ---- */
.feed{position:fixed;inset:auto 0 0 0;z-index:2;height:var(--feed);display:flex;flex-direction:column;
  background:var(--card);border-top:1px solid var(--line);box-shadow:0 -6px 24px rgba(0,0,0,.06)}
.feed-label{flex:none;margin:0;padding:12px 24px 8px;
  font:450 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;
  text-transform:uppercase;color:var(--ter)}
#feed{flex:1;min-height:0;overflow-y:auto;margin:0;padding:0 24px 12px;list-style:none}
#feed:empty::after{display:block;font-size:13px;color:var(--ter);
  content:"press a control in any screen above — every call it makes lands here"}
#feed li{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line);
  font:450 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  transition:opacity 150ms ease-out,transform 150ms ease-out}
#feed li:first-child{border-top:0}
#feed time{color:var(--ter);font-variant-numeric:tabular-nums}
#feed .who{font-weight:600;color:var(--sec)}
#feed code{color:var(--ink);background:var(--page);padding:1px 5px;border-radius:4px}
#feed .args{color:var(--ter);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The guard's resolution, on the row it resolves — pushed to the far edge so a
   parked write reads as one call that came back, not as two calls. */
#feed .approved{flex:none;margin-left:auto;color:var(--ok)}
@starting-style{#feed li{opacity:0;transform:translateY(-4px)}}
@media (prefers-reduced-motion:reduce){#feed li{transition:opacity 150ms ease-out}}
`;

/**
 * The feed's whole mechanism: every embedded page's `vendo.callTool` posts to
 * its parent (see `seam` in `render.ts`), and this is the parent. Text goes in
 * through `textContent`, never markup — a tool name in this feed came out of a
 * model, and the report must not let one write HTML into itself.
 *
 * WHO made the call is read off the frame the message arrived in, never off the
 * message. Every embedded page is a document a contender wrote, so the
 * `contender` field in the payload is only that page's word for itself: a
 * column could put a rival's name on its own calls, and anything the page
 * embedded — a child frame of its own — could post as a column entirely. A
 * sender that is not one of this report's own frames is not a contender.
 *
 * A GUARDED write posts twice — the ask, then the approval that released it
 * (`seam` in `render.ts`) — and the second one is the first one's outcome, not
 * another call. So it lands on the row already showing that ask, which is what a
 * person watching a screen press one button has to see. Matched by column and
 * tool name, which is enough: a write's approval is posted from the microtask its
 * own press queued, so it always arrives before any later press of the same tool
 * can post. A read's row is simply never claimed.
 *
 * No server, no shared state: the file works from disk, offline, forever.
 */
const FEED_SCRIPT = `
var parked = {};
addEventListener("message", function (event) {
  var call = event.data;
  if (call === null || typeof call !== "object" || call.genbench !== "call") return;
  var frames = document.querySelectorAll("iframe[data-contender]");
  var sender = null;
  for (var i = 0; i < frames.length; i += 1) {
    if (frames[i].contentWindow === event.source) sender = frames[i].getAttribute("data-contender");
  }
  if (sender === null) return;
  var key = sender + " " + call.name;
  if (call.approved) {
    var ask = parked[key];
    delete parked[key];
    if (ask === undefined) return;
    var tag = document.createElement("span");
    tag.className = "approved";
    tag.textContent = "✓ approved";
    ask.append(tag);
    return;
  }
  var row = document.createElement("li");
  var when = document.createElement("time");
  when.textContent = new Date(call.ts).toLocaleTimeString("en-US", { hour12: false });
  var who = document.createElement("span");
  who.className = "who";
  who.textContent = sender;
  var tool = document.createElement("code");
  tool.textContent = call.name;
  var args = document.createElement("span");
  args.className = "args";
  args.textContent = "{" + Object.keys(call.args || {}).map(function (key) {
    var value = call.args[key];
    return key + ": " + (typeof value === "string" ? value : JSON.stringify(value));
  }).join(", ") + "}";
  row.append(when, who, tool, args);
  parked[key] = row;
  document.getElementById("feed").prepend(row);
});
`;

/** One check across a column's screens: earned and failed are the screens it was
 *  really in front of, vacuous the ones it was not. */
export interface CheckTally {
  readonly earned: number;
  readonly failed: number;
  readonly vacuous: number;
}

/** One column's whole run in numbers. Floor cells and rubric lines are counted
 *  the way the page above counts them — through `checks` and through each
 *  line's own origin — so the summary and the preview cannot tell two stories. */
export interface ColumnSummary {
  readonly model: string;
  readonly cases: number;
  readonly floor: { earned: number; failed: number; vacuous: number; degraded: number };
  /** The cells `floor` sums, one tally per check instead of one total — with
   *  `wiredActions` as the three questions it answers at once (`splitChecks` in
   *  `floor.ts`): `pressed`, every control the probe pressed did something;
   *  `wired`, every call that fired named a real tool with arguments the world
   *  would accept; `actionProven`, a case that asked the screen to act showed its
   *  write or a confirmation that works. Not a re-count of `floor`, which does not
   *  move for any of this: a screen can miss two of the three at once and still be
   *  the one failed `wiredActions` cell it always was, so these six say WHICH
   *  disease a column has and `floor` goes on saying how much. Read off verdicts
   *  already on disk, so `genbench report <run folder>` fills it in for a run
   *  recorded before the split existed. */
  readonly floorChecks: Readonly<Record<string, CheckTally>>;
  /** The case's OWN lines: what this screen was asked to show. A case line's
   *  `na` counts as a fail (`tally`); a style line's does not, and is counted
   *  here instead. */
  readonly caseLines: { pass: number; fail: number; na: number };
  /** The standing honesty line, alone: whether the numbers on the screen are the
   *  tool data's. It was counted in `caseLines`, where a screen that invented a
   *  figure and a screen that missed a row moved one number by the same amount.
   *  Two buckets — a screen either showed honest numbers or it did not, so an
   *  `na` is counted the way `tally` counts one on any case line, as a fail.
   *
   *  `flipped` is how many of those passes are fails an independent check
   *  overturned, because it could not name the figure the judge said was
   *  invented (`honesty.ts`). Counted rather than hidden inside `pass`: it is the
   *  measure of how much of this line's score was the grader's noise, and a run
   *  where it climbs is a run whose judge is drifting.
   *
   *  `unadjudicated` is how many of the FAILS nobody checked at all: no screen was
   *  delivered, the judge never graded, or the call did not come back. It sits
   *  beside `flipped` because the two are read together — a run with fails, no
   *  flips and no unadjudicated is a run whose accusations were all confirmed,
   *  while the same run with every fail unadjudicated is a run whose check never
   *  answered, and until this was counted the summary printed the same numbers for
   *  both. */
  readonly honesty: { pass: number; fail: number; flipped: number; unadjudicated: number };
  readonly styleLines: { pass: number; fail: number; na: number };
  /** Whether this column's screens are BOUND to the host's data or merely
   *  decorated with it: of the values the screens displayed, how many moved when
   *  the data under them moved (`liveness.ts`). Reported, never gated — no floor
   *  cell and no exit code reads it. A screen that displayed none of the moved
   *  values is `vacuous` and out of both totals, the doctrine a `wiredActions`
   *  pass with nothing to press is counted under. All three are 0 for a run
   *  recorded before the axis existed, until `genbench liveness` fills it in. */
  readonly liveness: { live: number; displayed: number; vacuous: number };
  /** Of the cases that ASKED this column's screens to do something (`action` in
   *  `cases.json`), how far the presses got: `write` — one of them called a
   *  tool the world declares a write (a tool with no canned data, `riskOf` in
   *  `world.ts`); `dialog` — none did, and a press opened a confirmation the
   *  probe stops at; `none` — neither. Re-read from bindings already on disk,
   *  so `genbench report <run folder>` fills it in for a run recorded before
   *  the axis existed, with no model, no browser and no probe. Reported, never
   *  gated. All three are 0 for a run nothing could tell the action cases of. */
  readonly actions: { write: number; dialog: number; none: number };
  readonly timeouts: number;
  readonly judgeDegraded: number;
  /** How long this column took to answer, in milliseconds. Half the buy-versus-
   *  build question is time, and it had no aggregate anywhere: the preview
   *  printed one number per screen and the summary printed none. */
  readonly settledMs: { median: number; p90: number; worst: number };
  /** The middle case only, and only where a column reports a first render at
   *  all: it is a snapshot a driver chose to take, so a column that never took
   *  one says nothing rather than zero. */
  readonly firstRenderMedianMs?: number;
  readonly tokens: number;
  readonly usd: number;
}

export interface RunSummary {
  readonly run: string;
  /** The run this one re-scored, where it is one. The screens are that run's and
   *  so are its timings; only the verdicts on them are this run's. */
  readonly regradedFrom?: string;
  readonly gitSha: string;
  readonly rubricVersion: number;
  /** Every model id that answered, contenders and graders alike. */
  readonly models: readonly string[];
  readonly columns: Readonly<Record<string, ColumnSummary>>;
}

const lineCounts = (lines: readonly LineVerdict[]): { pass: number; fail: number; na: number } => ({
  pass: lines.filter((line) => line.verdict === "pass").length,
  fail: lines.filter((line) => line.verdict === "fail").length,
  na: lines.filter((line) => line.verdict === "na").length,
});

/** The honesty line in two buckets rather than three, for the reason `tally`
 *  grades a case line's `na` rather than excusing it: an unanswered line about
 *  the numbers on the screen is not a line that had no subject. Plus how many of
 *  the passes are the judge's own fails, overturned by a check that could not
 *  name the figure it accused (`honesty.ts`) — read off the record the flip left
 *  behind, never off the flipped verdict, which is now indistinguishable from a
 *  pass the judge reached itself. And how many of the fails nobody checked, read
 *  off the record the same way: every fail carries one, so a fail with no record
 *  is a bug in the writer rather than a case to count. */
const honestyCounts = (
  rows: readonly CaseResult[],
): { pass: number; fail: number; flipped: number; unadjudicated: number } => {
  const lines = inHalf(rows.flatMap((row) => row.judged.lines), "honesty");
  return {
    pass: lines.filter((line) => line.verdict === "pass").length,
    fail: lines.filter((line) => line.verdict !== "pass").length,
    flipped: rows.filter((row) => row.judged.honesty?.verdict === "none").length,
    unadjudicated: rows.filter((row) => row.judged.honesty?.verdict === "unadjudicated").length,
  };
};

/** The floor's cells kept apart by name, each counted exactly the way `floor`
 *  counts all four at once: a vacuous cell out of both halves and beside them. */
const checkTallies = (
  rows: readonly CaseResult[],
  actionCases: ReadonlySet<string>,
): Record<string, CheckTally> => {
  const cells = splitOf(rows, actionCases);
  return Object.fromEntries(
    [...new Set(cells.map((check) => check.name))].map((name) => {
      const mine = cells.filter((check) => check.name === name);
      const graded = mine.filter((check) => check.vacuous !== true);
      return [
        name,
        {
          earned: graded.filter((check) => check.pass).length,
          failed: graded.filter((check) => !check.pass).length,
          vacuous: mine.length - graded.length,
        },
      ];
    }),
  );
};

/**
 * The run's one number, per column, in one file.
 *
 * Everything else this benchmark writes is per case: a run folder per case, a
 * preview section per case, a floor table broken out by shape. Fourteen worlds
 * and 200 cases is 200 of those and no total anywhere, so the question the whole
 * thing exists to answer — is buying this better than building it — had no
 * answer in code. This is that answer, honestly counted and nothing more: no
 * weighting, no score out of ten, no chart.
 */
export async function writeSummary(input: {
  runDir: string;
  runId: string;
  results: readonly CaseResult[];
  gitSha: string;
  /** Set only by `regrade`, which re-scores another run's screens. */
  regradedFrom?: string;
  /** The world each case ran against, and which cases asked the screen to act —
   *  what the write axis is read against. Absent where a caller has neither,
   *  which costs that axis and nothing else. */
  worlds?: Readonly<Record<string, World>>;
  actionCases?: ReadonlySet<string>;
}): Promise<string> {
  const worlds = input.worlds ?? {};
  const actionCases = input.actionCases ?? new Set<string>();
  const columns: Record<string, ColumnSummary> = {};
  for (const contender of new Set(input.results.map((result) => result.contender))) {
    const rows = input.results.filter((result) => result.contender === contender);
    const scored = rows.flatMap((row) => checks(row.floor));
    const graded = scored.filter((check) => check.vacuous !== true && check.degraded !== true);
    const lines = rows.flatMap((row) => row.judged.lines);
    const firstRenders = rows.flatMap((row) => row.timing.firstRenderMs ?? []);
    columns[contender] = {
      model: rows[0]!.model,
      cases: rows.length,
      floor: {
        earned: graded.filter((check) => check.pass).length,
        failed: graded.filter((check) => !check.pass).length,
        vacuous: scored.filter((check) => check.vacuous === true).length,
        degraded: scored.filter((check) => check.degraded === true).length,
      },
      floorChecks: checkTallies(rows, actionCases),
      caseLines: lineCounts(inHalf(lines, "correctness")),
      honesty: honestyCounts(rows),
      styleLines: lineCounts(inHalf(lines, "design")),
      liveness: bound(rows),
      actions: acted(rows, worlds, actionCases),
      timeouts: rows.filter((row) => row.failure === "timeout").length,
      judgeDegraded: rows.filter((row) => row.judged.degraded).length,
      settledMs: durations(rows),
      ...(firstRenders.length === 0 ? {} : { firstRenderMedianMs: at(firstRenders, 0.5) }),
      tokens: rows.reduce(
        (total, { cost }) =>
          total + cost.usage.inputTokens + cost.usage.outputTokens + cost.usage.cacheReadTokens + cost.usage.cacheWriteTokens,
        0,
      ),
      usd: rows.reduce((total, row) => total + row.cost.usd, 0),
    };
  }

  const first = input.results[0];
  const summary: RunSummary = {
    run: input.runId,
    ...(input.regradedFrom === undefined ? {} : { regradedFrom: input.regradedFrom }),
    gitSha: input.gitSha,
    rubricVersion: first?.judgeContract.rubricVersion ?? 0,
    models: [
      ...new Set(
        input.results.flatMap((result) => [result.modelVersion ?? result.model, result.judged.modelVersion]),
      ),
    ].filter((id): id is string => id !== undefined),
    columns,
  };
  const path = join(input.runDir, "summary.json");
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
  return path;
}

/**
 * One page per run: every contender's REAL screen side by side under its own
 * verdicts and numbers, each case with the data those screens were graded
 * against, and one live feed of what pressing anything actually calls.
 *
 * It stays a single static file you can `open` — the live frames are relative
 * links into the run folder beside it, and the judge's screenshots are inlined.
 */
export async function writePreview(input: {
  runDir: string;
  runId: string;
  results: readonly CaseResult[];
  worlds: Readonly<Record<string, World>>;
  /** The cases that asked the screen to DO something. A saved result carries no
   *  tags, so this is what says which screens the write row is about; without
   *  it that row is the only thing on the page that goes quiet. */
  actionCases?: ReadonlySet<string>;
}): Promise<string> {
  const first = input.results[0];
  const actionCases = input.actionCases ?? new Set<string>();
  // Grouped in first-seen order, and each group in the order the row was run:
  // which contender finished first never moves a column.
  const order = [...new Set(input.results.map((result) => result.case))];
  const sections = await Promise.all(
    order.map(
      async (testCase) =>
        await caseSection(
          input.runDir,
          testCase,
          input.results.filter((result) => result.case === testCase),
          input.worlds[testCase],
        ),
    ),
  );

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>genbench · ${escape(first?.case ?? input.runId)}</title>
<style>${CSS}</style></head><body><div class="wrap">
<h1>genbench</h1>
<p class="meta"><span>${escape(input.runId)}</span><span>world ${escape(first?.world ?? "")}</span><span>${escape(first?.lane ?? "screen")} lane</span></p>
${spendLine("judge", "graded", spent(input.results, (result) => result.judged.cost))}
${checkTable(input.results, actionCases)}
${shapeTable(input.results, input.worlds, actionCases)}
${sections.join("")}
</div>
<aside class="feed"><p class="feed-label">tool calls</p><ol id="feed"></ol></aside>
<script>${FEED_SCRIPT}</script>
</body></html>`;
  const path = join(input.runDir, "preview.html");
  await writeFile(path, html);
  return path;
}
