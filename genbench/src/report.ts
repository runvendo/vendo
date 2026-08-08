import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Binding, FloorResult, Offender } from "./floor.js";
import type { CaseResult } from "./run.js";

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const verdict = (ok: boolean): string =>
  `<span class="v ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${ok ? "pass" : "fail"}</span>`;

const CHECKS = ["delivered", "renders", "valid", "honestData", "wiredActions"] as const;

const passes = (floor: FloorResult): boolean[] => [
  floor.delivered,
  floor.renders,
  floor.valid,
  floor.honestData.pass,
  floor.wiredActions.pass,
];

const offenderList = (offenders: readonly Offender[]): string =>
  offenders.length === 0
    ? ""
    : `<ul class="notes">${offenders
        .map((o) => `<li><code>${escape(o.text)}</code> <span>${escape(o.why)}</span></li>`)
        .join("")}</ul>`;

const bindingList = (bindings: readonly Binding[]): string =>
  bindings.length === 0
    ? `<ul class="notes"><li><span>nothing on this screen to press</span></li></ul>`
    : `<ul class="notes">${bindings
        .map(
          (b) =>
            `<li><code>${escape(b.where)}</code> <span>${escape(b.tool ?? "—")}${
              b.why === undefined ? "" : ` — ${escape(b.why)}`
            }</span> ${b.known && b.argsValid ? '<i class="ok">✓</i>' : '<i class="no">✕</i>'}</li>`,
        )
        .join("")}</ul>`;

/** `renders` can fail for a reason no screenshot shows, so the reason is on the
 *  page next to the verdict. */
const consoleNote = (errors: readonly string[]): string =>
  errors.length === 0
    ? ""
    : `<p class="warn">${errors.length} console error${errors.length === 1 ? "" : "s"} while painting: ${escape(errors[0]!)}</p>`;

const metric = (label: string, value: string): string =>
  `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`;

async function column(runDir: string, result: CaseResult): Promise<string> {
  const caseDir = join(result.contender, result.case);
  const shot = await readFile(join(runDir, caseDir, "screenshot.png")).catch(() => undefined);
  const page = await readFile(join(runDir, caseDir, "page.html"), "utf8").catch(() => undefined);
  const scored = passes(result.floor);
  const total = scored.filter(Boolean).length;
  const { usage } = result.cost;
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

  return `<section class="col">
  <header>
    <div><h2>${escape(result.contender)}</h2><p>${escape(result.model)}</p></div>
    <span class="score ${total === 5 ? "ok" : "no"}">${total}/5</span>
  </header>
  <figure>${
    page === undefined
      ? `<div class="blank">nothing rendered</div>`
      : `<iframe title="${escape(result.case)} as ${escape(result.contender)} built it" src="${escape(caseDir)}/page.html" loading="lazy"></iframe>`
  }</figure>
  ${
    shot === undefined
      ? ""
      : `<div class="judge"><img alt="the screenshot ${escape(result.case)} was scored from"
        src="data:image/png;base64,${shot.toString("base64")}"><p>what the judge saw</p></div>`
  }
  ${result.failure === undefined ? "" : `<p class="failure">${escape(result.failure)}</p>`}
  ${consoleNote(result.consoleErrors)}
  <dl class="floor">${CHECKS.map((name, index) => `<div><dt>${name}</dt><dd>${verdict(scored[index]!)}</dd></div>`).join("")}</dl>
  ${
    result.floor.blocking.length === 0
      ? ""
      : `<ul class="notes">${result.floor.blocking.map((why) => `<li><span>${escape(why)}</span></li>`).join("")}</ul>`
  }
  ${result.floor.honestData.pass ? "" : offenderList(result.floor.honestData.offenders)}
  ${bindingList(result.floor.wiredActions.bindings)}
  <dl class="metrics">
    ${metric("first render", result.timing.firstRenderMs === undefined ? "—" : `${result.timing.firstRenderMs} ms`)}
    ${metric("settled", `${result.timing.settledMs} ms`)}
    ${metric("tokens", tokens.toLocaleString("en-US"))}
    ${metric("cost", `$${result.cost.usd.toFixed(4)}`)}
  </dl>
</section>`;
}

const CSS = `
:root{--ink:#17171a;--sec:#5c5c66;--ter:#8e8e99;--page:#f6f5f3;--card:#fff;--line:#e6e4e0;--ok:#1d7a4f;--no:#b4342a;}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);
  font:450 15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;border-top:3px solid var(--ink);}
.wrap{max-width:1240px;margin:0 auto;padding:32px 24px 64px}
h1{margin:0;font-size:28px;font-weight:600;letter-spacing:-.02em}
.prompt{margin:8px 0 0;font-size:15px;color:var(--sec);max-width:62ch}
.meta{margin:16px 0 0;font:450 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.meta span+span::before{content:"·";margin:0 8px;color:var(--line)}
/* Capped, not fluid: the screenshots are shot at a fixed 480px, so letting a
   single column stretch to the full page would upscale and blur the one
   artifact the whole page exists to show. */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,540px));gap:24px;margin-top:32px;justify-content:center}
.col{background:var(--card);border-radius:10px;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05)}
.col>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
h2{margin:0;font-size:15px;font-weight:600}
.col>header p{margin:2px 0 0;font-size:12px;color:var(--ter)}
.score{font:600 13px/1 ui-monospace,Menlo,monospace;padding:5px 8px;border-radius:6px}
.score.ok{color:var(--ok);background:#e8f3ed}.score.no{color:var(--no);background:#fbeceb}
figure{margin:16px 0 0;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden}
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
.notes{margin:10px 0 0;padding:0;list-style:none}
.notes li{display:flex;gap:8px;align-items:baseline;padding:4px 0;font-size:12px;color:var(--ter)}
.notes code{font:450 12px/1.4 ui-monospace,Menlo,monospace;color:var(--ink);background:var(--page);padding:1px 5px;border-radius:4px}
.notes i{margin-left:auto;font-style:normal}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.metrics>div{display:block}
.metrics dt{font:450 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.metrics dd{margin:6px 0 0;font:450 15px/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
`;

/** One page per run: every contender's REAL screen side by side, live and
 *  scrollable, each under its own floor verdicts and numbers. It stays a single
 *  static file you can `open` — the live frames are relative links into the run
 *  folder beside it, and the judge's screenshots are inlined. */
export async function writePreview(input: {
  runDir: string;
  runId: string;
  results: readonly CaseResult[];
}): Promise<string> {
  const first = input.results[0];
  const columns = await Promise.all(input.results.map(async (result) => await column(input.runDir, result)));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>genbench · ${escape(first?.case ?? input.runId)}</title>
<style>${CSS}</style></head><body><div class="wrap">
<h1>${escape(first?.case ?? "run")}</h1>
<p class="prompt">${escape(first?.prompt ?? "")}</p>
<p class="meta"><span>${escape(input.runId)}</span><span>world ${escape(first?.world ?? "")}</span><span>${escape(first?.lane ?? "screen")} lane</span></p>
<div class="grid">${columns.join("")}</div>
</div></body></html>`;
  const path = join(input.runDir, "preview.html");
  await writeFile(path, html);
  return path;
}
