import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checks,
  holds,
  type Audited,
  type Binding,
  type HonestDataResult,
  type HonestVerdict,
  type Offender,
  type WiredActionsResult,
} from "./floor.js";
import type { JudgeResult, LineVerdict, Verdict } from "./judge.js";
import type { UsageTotals } from "./meter.js";
import type { CaseResult } from "./run.js";
import { cannedResponse, type World } from "./world.js";

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const verdict = (ok: boolean): string =>
  `<span class="v ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${ok ? "pass" : "fail"}</span>`;

/** honestData's own verdict: a fail reads exactly as any other failing check
 *  does, but a pass splits in three. `examined` values cleared is what a real
 *  pass earned — of `found`, where the cap bit, because a number nobody looked
 *  at must be visible rather than inferred. `examined` at 0 means the screen had
 *  nothing extractable, and a DEGRADED check means our own machinery could not
 *  be reached: both are muted, and neither wears the checkmark a screen that was
 *  actually examined gets. */
const honestDataVerdict = (data: HonestDataResult): string => {
  if (data.degraded === true) return `<span class="v muted">— not checked</span>`;
  if (!data.pass) return verdict(false);
  if (data.examined === 0) return `<span class="v muted">— nothing to check</span>`;
  const of = data.found > data.examined ? ` of ${data.found}` : "";
  return `<span class="v ok">✓ · ${data.examined}${of} value${data.examined === 1 ? "" : "s"} checked</span>`;
};

/** `wiredActions` splits the same two ways, and for the same reason: a screen
 *  with nothing to press passes without a single control having been proven
 *  live, and that must not wear the checkmark a screen full of working controls
 *  earned. */
const wiredActionsVerdict = (actions: WiredActionsResult): string => {
  if (!actions.pass) return verdict(false);
  if (actions.pressed === 0) return `<span class="v muted">— nothing to press</span>`;
  return `<span class="v ok">✓ · ${actions.pressed} control${actions.pressed === 1 ? "" : "s"} pressed</span>`;
};

/** Every small list under a verdict — offenders, bindings, blocking findings —
 *  is this list. */
const notes = (rows: readonly string[]): string => `<ul class="notes">${rows.join("")}</ul>`;

const offenderList = (offenders: readonly Offender[]): string =>
  offenders.length === 0
    ? ""
    : notes(offenders.map((o) => `<li><code>${escape(o.text)}</code> <span>${escape(o.why)}</span></li>`));

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

/** The row's mark and its CSS class, per verdict. A waiver is `na` — the same
 *  recessive row a rubric line whose subject is absent gets, because it is the
 *  same statement: there was nothing here to earn or miss. */
const HONEST_MARK: Readonly<Record<HonestVerdict, { mark: string; row: string }>> = {
  "cleared-by-verbatim": { mark: "✓", row: "pass" },
  "cleared-by-audit": { mark: "✓", row: "pass" },
  "skipped-by-triage": { mark: "–", row: "na" },
  offender: { mark: "✕", row: "fail" },
};

/** What settled this value, in a sentence. Attempts are named only where any
 *  were spent: "0 attempts" beside a value the tools answered with verbatim
 *  reads as a failure to try. */
const honestNote = (record: Audited): string => {
  const attempts = record.attempts === 0 ? "" : ` · ${record.attempts} attempt${record.attempts === 1 ? "" : "s"}`;
  switch (record.verdict) {
    case "cleared-by-verbatim":
      return `cleared — ${record.result}`;
    case "skipped-by-triage":
      return `not a data claim — ${record.result}`;
    case "cleared-by-audit":
      return `cleared — executed to ${record.result}${attempts}`;
    default:
      return `${record.result}${attempts}`;
  }
};

/**
 * The honesty check's evidence: every value the screen printed, and what settled
 * it — the tools' own text, a triage waiver in the model's own clause, or a
 * program that was executed and what it returned.
 *
 * On the page rather than behind a hover, for the same reason the judge's notes
 * are — these verdicts were reached by a model waiving and by code running, and
 * neither is something a reader should have to take on trust. The value stays
 * the thing you scan for; the program is demoted to a muted well beneath it.
 */
const auditList = (data: HonestDataResult): string => {
  const audited = data.audited ?? [];
  if (audited.length === 0) return "";
  const waived = audited.filter((record) => record.verdict === "skipped-by-triage").length;
  const cleared = audited.filter((record) => record.verdict.startsWith("cleared")).length;
  return `<section class="audit">
  ${
    data.degraded === true
      ? `<p class="degraded">honesty check degraded — nothing here was waived or cleared on a model's word${data.error === undefined ? "" : `: ${escape(data.error)}`}</p>`
      : ""
  }
  <p class="half-head"><span>honesty · the tools' own text, then triage, then executed code</span><b>${cleared}/${audited.length - waived}${waived === 0 ? "" : ` · ${waived} waived`}</b></p>
  <ul class="lines">${audited
    .map((record) => {
      const { mark, row } = HONEST_MARK[record.verdict];
      return (
        `<li class="${row}"><i aria-hidden="true">${mark}</i><span class="what">` +
        `<span class="line"><code>${escape(record.text)}</code></span>` +
        (record.program.trim() === "" ? "" : `<pre class="program">${escape(record.program)}</pre>`) +
        `<span class="note">${escape(honestNote(record))}</span>` +
        `</span></li>`
      );
    })
    .join("")}</ul>
</section>`;
};

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
 * world's `style` lines are design, and each verdict carries the evidence it
 * was reached on.
 *
 * A degraded judgement is the GRADER having a bad afternoon, not the contender
 * failing, so it says so at the top and prints no tally: every line reads
 * `fail` in that state, and "0/2" beside a column is a sentence about the
 * contender that would not be true.
 */
const rubric = (judged: JudgeResult): string =>
  judged.lines.length === 0
    ? ""
    : `<section class="rubric">
  ${
    judged.degraded
      ? `<p class="degraded">judge degraded — this screen was not graded${judged.error === undefined ? "" : `: ${escape(judged.error)}`}</p>`
      : ""
  }
  ${rubricHalf("correctness", judged.lines.filter((line) => line.source === "case"), judged.degraded)}
  ${rubricHalf("design", judged.lines.filter((line) => line.source === "style"), judged.degraded)}
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
        check.name === "honestData"
          ? honestDataVerdict(result.floor.honestData)
          : check.name === "wiredActions"
            ? wiredActionsVerdict(result.floor.wiredActions)
            : verdict(check.pass);
      return `<div><dt>${check.name}</dt><dd>${shown}</dd></div>`;
    })
    .join("")}</dl>
  ${result.floor.blocking.length === 0 ? "" : notes(result.floor.blocking.map((why) => `<li><span>${escape(why)}</span></li>`))}
  ${result.floor.honestData.pass ? "" : offenderList(result.floor.honestData.offenders)}
  ${auditList(result.floor.honestData)}
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
 * The judge and the auditor are the benchmark's overhead, not a contender's
 * bill: folding either into a `cost` figure would quietly make every column more
 * expensive than the thing it measures, and two runs graded a different number
 * of times would stop comparing. So each is said here, once, and left out of
 * every column.
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
 * The run's floor score by shape — the only place on this page a contender's
 * screens are added up at all. Every column below is a single screen, so a
 * contender that holds the floor everywhere except charts says so here and
 * nowhere else.
 *
 * The cells are the columns' OWN checks, summed: `checks` is the same function
 * `column` scores with, so a cell can never disagree with the columns beneath it
 * except by being their total. A shape nobody ran a case for is muted rather
 * than scored, for the reason a vacuous `honestData` pass is — 0/0 painted green
 * is a claim about a contender that was never put to the test.
 *
 * And a vacuous or degraded check is out of the numerator AND the denominator,
 * counted beside them instead. Summing bare booleans is how a blank page — no
 * numbers to check, nothing to press — scored 5/5 here while the preview under
 * it was already muting both of those cells as unearned.
 */
const shapeTable = (results: readonly CaseResult[]): string => {
  if (results.length === 0) return "";
  const shapes = [...new Set(results.map((result) => result.shape))].sort();
  // First-seen, so the cells read left to right in the column order below.
  const contenders = [...new Set(results.map((result) => result.contender))];
  const cell = (rows: readonly CaseResult[]): string => {
    const { passed, of, aside } = earned(rows.flatMap((row) => checks(row.floor)));
    if (of === 0) return `<td class="muted">—${escape(aside)}</td>`;
    return `<td class="${passed === of ? "ok" : "no"}">${passed}/${of}${escape(aside)}</td>`;
  };
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
</table>`;
};

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
   The cap lives here rather than on the grid track: it is what stops a column
   from stretching past the width its screen was designed at, and it is the one
   number to move if a world ever ships more than three contenders. */
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
.shapes .muted{color:var(--ter)}
/* The prompt is the heading a person reads; the case id is a filename. */
.case{margin-top:48px}
.case-id{margin:0;font:450 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.prompt{margin:10px 0 0;font-size:20px;font-weight:500;line-height:1.35;letter-spacing:-.01em;max-width:62ch}
/* Provenance, never a score: quieter than the prompt it sits under. */
.source{margin:6px 0 0;font-size:12px;color:var(--ter);max-width:62ch}
.source a{color:inherit}
/* Every contender in ONE row, because the whole page is a comparison and a
   column you have to scroll to find is a column you never compare.

   The max track sizing function must stay FLEXIBLE. auto-fit counts its
   repetitions off the max when that max is a definite length, so the previous
   minmax(360px,540px) asked "how many 540px columns fit?" and answered two at
   every viewport — the third wrapped a full row down, where lazy loading then
   kept it blank. With 1fr the count comes off the 360px min instead: three
   columns from ~1176px up, two below that, one on a phone. */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:24px;margin-top:24px}
.col{background:var(--card);border-radius:10px;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05)}
.col>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
h2{margin:0;font-size:15px;font-weight:600}
.col>header p{margin:2px 0 0;font-size:12px;color:var(--ter)}
.score{font:600 13px/1 ui-monospace,Menlo,monospace;padding:5px 8px;border-radius:6px}
.score.ok{color:var(--ok);background:#e8f3ed}.score.no{color:var(--no);background:#fbeceb}
/* Full-bleed to the card's edges: the card's own padding was costing the
   embedded screen 40px of width, which is the difference between a contender's
   page fitting and its right-hand controls being clipped. The frame is the one
   thing on this page that must be as close as possible to the 480px the
   screenshots are shot at, so it gets the whole card. */
figure{margin:16px -20px 0;background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line);overflow:hidden}
iframe{display:block;width:100%;height:660px;border:0;background:#fff}
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
/* A vacuous pass: nothing was extractable, so nothing was actually cleared.
   Same weight as the labels around it, never the green a real pass earns. */
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

/* ---- the honesty check: every value, and what settled it ----
   Same spacing step and the same verdict rows as the rubric above, because it
   is the same kind of claim. The program is a filled well rather than a
   bordered box — one less border in a column that already has plenty. */
.audit{margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.audit .line code{font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
.program{margin:6px 0 0;padding:8px 10px;background:var(--page);border-radius:6px;
  white-space:pre-wrap;overflow-wrap:anywhere;
  font:450 11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sec)}

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
 * No server, no shared state: the file works from disk, offline, forever.
 */
const FEED_SCRIPT = `
addEventListener("message", function (event) {
  var call = event.data;
  if (call === null || typeof call !== "object" || call.genbench !== "call") return;
  var frames = document.querySelectorAll("iframe[data-contender]");
  var sender = null;
  for (var i = 0; i < frames.length; i += 1) {
    if (frames[i].contentWindow === event.source) sender = frames[i].getAttribute("data-contender");
  }
  if (sender === null) return;
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
  document.getElementById("feed").prepend(row);
});
`;

/** One column's whole run in numbers. Floor cells and rubric lines are counted
 *  the way the page above counts them — through `checks` and through each
 *  line's own origin — so the summary and the preview cannot tell two stories. */
export interface ColumnSummary {
  readonly model: string;
  readonly cases: number;
  readonly floor: { earned: number; failed: number; vacuous: number; degraded: number };
  /** A case line's `na` counts as a fail (`tally`); a style line's does not, and
   *  is counted here instead. */
  readonly caseLines: { pass: number; fail: number; na: number };
  readonly styleLines: { pass: number; fail: number; na: number };
  readonly timeouts: number;
  readonly judgeDegraded: number;
  readonly tokens: number;
  readonly usd: number;
}

export interface RunSummary {
  readonly run: string;
  readonly gitSha: string;
  readonly rubricVersion: number;
  readonly auditVersion: number;
  readonly triageVersion: number;
  /** Every model id that answered, contenders and graders alike. */
  readonly models: readonly string[];
  readonly columns: Readonly<Record<string, ColumnSummary>>;
}

const lineCounts = (
  lines: readonly LineVerdict[],
  source: LineVerdict["source"],
): { pass: number; fail: number; na: number } => {
  const half = lines.filter((line) => line.source === source);
  return {
    pass: half.filter((line) => line.verdict === "pass").length,
    fail: half.filter((line) => line.verdict === "fail").length,
    na: half.filter((line) => line.verdict === "na").length,
  };
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
}): Promise<string> {
  const columns: Record<string, ColumnSummary> = {};
  for (const contender of new Set(input.results.map((result) => result.contender))) {
    const rows = input.results.filter((result) => result.contender === contender);
    const scored = rows.flatMap((row) => checks(row.floor));
    const graded = scored.filter((check) => check.vacuous !== true && check.degraded !== true);
    const lines = rows.flatMap((row) => row.judged.lines);
    columns[contender] = {
      model: rows[0]!.model,
      cases: rows.length,
      floor: {
        earned: graded.filter((check) => check.pass).length,
        failed: graded.filter((check) => !check.pass).length,
        vacuous: scored.filter((check) => check.vacuous === true).length,
        degraded: scored.filter((check) => check.degraded === true).length,
      },
      caseLines: lineCounts(lines, "case"),
      styleLines: lineCounts(lines, "style"),
      timeouts: rows.filter((row) => row.failure === "timeout").length,
      judgeDegraded: rows.filter((row) => row.judged.degraded).length,
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
    gitSha: input.gitSha,
    rubricVersion: first?.judgeContract.rubricVersion ?? 0,
    auditVersion: first?.auditorContract.auditVersion ?? 0,
    triageVersion: first?.triageContract.triageVersion ?? 0,
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
}): Promise<string> {
  const first = input.results[0];
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
${spendLine("honesty check", "sorted and audited", spent(input.results, (result) => result.floor.honestData.cost))}
${shapeTable(input.results)}
${sections.join("")}
</div>
<aside class="feed"><p class="feed-label">tool calls</p><ol id="feed"></ol></aside>
<script>${FEED_SCRIPT}</script>
</body></html>`;
  const path = join(input.runDir, "preview.html");
  await writeFile(path, html);
  return path;
}
