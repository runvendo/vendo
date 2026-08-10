/**
 * One page per harness run: the conversation, what it called, and what it earned.
 *
 * It borrows the screen report's stylesheet (`CSS` in report.ts) on purpose —
 * one run of this benchmark should not look like two products — and adds only the
 * rules a TRANSCRIPT needs, because that is what a harness run is instead of a
 * grid of screens: there is no page to embed, no screenshot to demote and no
 * control to press, so the frame, the thumbnail and the call feed have nothing to
 * show.
 *
 * It stays one static file — no server, offline, forever.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessCheck, RecordedCall, RecordedTurn } from "./harness-checks.js";
import type { HarnessCaseResult } from "./harness-lane.js";
import type { JudgeResult, LineVerdict, Verdict } from "./judge.js";
import { CSS, tally } from "./report.js";
import { cannedResponse, type World } from "./world.js";

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const MARK: Readonly<Record<Verdict, string>> = { pass: "✓", fail: "✕", na: "–" };

/** The transcript's own rules. Everything else on the page is the screen
 *  report's, so this is only what a conversation adds. */
const TRANSCRIPT_CSS = `
.turn{margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.turn:first-of-type{border-top:0;padding-top:0}
.said{margin:0;font-size:14px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.who-said{margin:0 0 4px;font:450 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.ask .said{color:var(--sec)}
.reply{margin-top:10px}
.calls{margin:10px 0 0;padding:0;list-style:none}
.calls li{display:flex;gap:8px;align-items:baseline;padding:5px 0;border-top:1px solid var(--line);
  font:450 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.calls code{color:var(--ink);background:var(--page);padding:1px 5px;border-radius:4px}
.calls .args{color:var(--ter);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.calls .out{margin-left:auto;flex:none;font-weight:600}
.calls .ok{color:var(--ok)}.calls .no{color:var(--no)}.calls .muted{color:var(--ter)}
/* The reason a check reached its verdict sits UNDER its name, never run onto
   the end of it: "toolBudget2 host calls" is one word to a reader. */
.checks dt{display:block}
.checks dt .why{display:block;margin-top:2px;font-size:12px;color:var(--ter)}
`;

const verdict = (ok: boolean): string =>
  `<span class="v ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${ok ? "pass" : "fail"}</span>`;

/** Every call of one turn: the tool, the arguments verbatim, and how it ended.
 *  Verbatim because the arguments ARE the verdict on half these cases — the id a
 *  cancel was aimed at is the difference between the right transfer and someone
 *  else's. */
const callList = (calls: readonly RecordedCall[]): string =>
  calls.length === 0
    ? ""
    : `<ul class="calls">${calls
        .map((call) => {
          const mark =
            call.status === "ok"
              ? '<span class="out ok">ok</span>'
              : call.status === "denied"
                ? '<span class="out muted">denied</span>'
                : '<span class="out no">error</span>';
          return (
            `<li><code>${escape(call.tool)}</code>` +
            `<span class="args">${escape(JSON.stringify(call.args))}</span>${mark}</li>`
          );
        })
        .join("")}</ul>`;

const turnBlock = (turn: RecordedTurn, index: number): string => `<div class="turn">
  <p class="who-said">turn ${index + 1} · person · ${turn.ms} ms</p>
  <div class="ask"><p class="said">${escape(turn.ask)}</p></div>
  ${callList(turn.calls)}
  <div class="reply"><p class="who-said">assistant</p><p class="said">${escape(
    turn.reply === "" ? "(said nothing)" : turn.reply,
  )}</p></div>
  ${turn.failure === undefined ? "" : `<p class="failure">${escape(turn.failure)}</p>`}
</div>`;

/** The deterministic half: the case's own contract, line by line, with the
 *  reason a failure failed. This is what decides the run's exit code. */
const checkList = (checks: readonly HarnessCheck[]): string =>
  `<dl class="floor checks">${checks
    .map(
      (check) =>
        `<div><dt>${escape(check.name)}${
          check.why === undefined ? "" : `<span class="why">${escape(check.why)}</span>`
        }</dt><dd>${verdict(check.pass)}</dd></div>`,
    )
    .join("")}</dl>`;

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

const rubric = (judged: JudgeResult): string =>
  judged.lines.length === 0
    ? ""
    : `<section class="rubric">
  ${
    judged.degraded
      ? `<p class="degraded">judge degraded — this conversation was not graded${
          judged.error === undefined ? "" : `: ${escape(judged.error)}`
        }</p>`
      : ""
  }
  ${rubricHalf("correctness", judged.lines.filter((line) => line.source === "case"), judged.degraded)}
  ${rubricHalf("voice", judged.lines.filter((line) => line.source === "style"), judged.degraded)}
</section>`;

const metric = (label: string, value: string): string =>
  `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`;

function column(result: HarnessCaseResult): string {
  const passed = result.checks.filter((check) => check.pass).length;
  const { usage } = result.cost;
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const hostCalls = result.turns.reduce((total, turn) => total + turn.calls.length, 0);
  return `<section class="col">
  <header>
    <div><h2>${escape(result.contender)}</h2><p>${escape(result.model)}</p></div>
    <span class="score ${result.pass ? "ok" : "no"}">${passed}/${result.checks.length}</span>
  </header>
  ${result.failure === undefined ? "" : `<p class="failure">${escape(result.failure)}</p>`}
  ${result.turns.map(turnBlock).join("")}
  ${checkList(result.checks)}
  ${rubric(result.judged)}
  <dl class="metrics">
    ${metric("first reply", result.timing.firstReplyMs === undefined ? "—" : `${result.timing.firstReplyMs} ms`)}
    ${metric("settled", `${result.timing.settledMs} ms`)}
    ${metric("calls", String(hostCalls))}
    ${metric("cost", `$${result.cost.usd.toFixed(4)}`)}
  </dl>
</section>`;
}

/** The case's own truth, collapsed: every tool this conversation could call and
 *  the exact response it answers with — the case's own tools included, which is
 *  the only place a reader can see them. */
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
  <summary><span class="chev">▸</span>World data · ${world.tools.length} tools · the only figures these replies may state</summary>
  <div class="tools">${tools}</div>
</details>`;
}

export async function writeHarnessPreview(input: {
  runDir: string;
  runId: string;
  results: readonly HarnessCaseResult[];
  worlds: Readonly<Record<string, World>>;
}): Promise<string> {
  const first = input.results[0];
  const order = [...new Set(input.results.map((result) => result.case))];
  const sections = order
    .map((testCase) => {
      const columns = input.results.filter((result) => result.case === testCase);
      return `<section class="case">
  <p class="case-id">${escape(testCase)}</p>
  <h2 class="prompt">${escape(columns[0]?.prompt ?? "")}</h2>
  ${worldPanel(input.worlds[testCase])}
  <div class="grid">${columns.map(column).join("")}</div>
</section>`;
    })
    .join("");
  const judgeCost = input.results.reduce((total, result) => total + (result.judged.cost?.usd ?? 0), 0);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>genbench harness · ${escape(first?.case ?? input.runId)}</title>
<style>${CSS}${TRANSCRIPT_CSS}</style></head><body><div class="wrap">
<h1>genbench · harness</h1>
<p class="meta"><span>${escape(input.runId)}</span><span>world ${escape(first?.world ?? "")}</span><span>harness lane</span></p>
<p class="meta spend"><span>judge · ${input.results.length} conversation${input.results.length === 1 ? "" : "s"} graded</span><span>$${judgeCost.toFixed(4)}</span><span>not counted in any case's cost</span></p>
${sections}
</div></body></html>`;
  // A run whose every case died wrote no case folder, and the page that says so
  // is the one thing a person still needs.
  await mkdir(input.runDir, { recursive: true });
  const path = join(input.runDir, "preview.html");
  await writeFile(path, html);
  return path;
}
