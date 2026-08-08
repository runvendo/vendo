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
    ? `<ul class="notes"><li><span>no tool bindings on this screen</span></li></ul>`
    : `<ul class="notes">${bindings
        .map(
          (b) =>
            `<li><code>${escape(b.tool)}</code> <span>${escape(b.where)}${
              b.why === undefined ? "" : ` — ${escape(b.why)}`
            }</span> ${b.known && b.argsValid ? '<i class="ok">✓</i>' : '<i class="no">✕</i>'}</li>`,
        )
        .join("")}</ul>`;

/** Islands and Kit charts both need the browser, so both leave a gap in a
 *  server-rendered shot. Says so in as many words, and counts them. */
function clientOnlyNote(islands: number, charts: number): string {
  const parts = [
    islands > 0 ? `${islands} generated island${islands === 1 ? "" : "s"}` : "",
    charts > 0 ? `${charts} chart${charts === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  const subject = parts.join(" and ");
  const verb = islands + charts === 1 ? "is" : "are";
  return `<p class="warn">${subject} on this screen ${verb} client-only — leaving an empty band in this server-rendered shot</p>`;
}

const metric = (label: string, value: string): string =>
  `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`;

async function column(runDir: string, result: CaseResult): Promise<string> {
  const shot = await readFile(join(runDir, result.contender, result.case, "screenshot.png")).catch(() => undefined);
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
    shot === undefined
      ? `<div class="blank">nothing rendered</div>`
      : `<img alt="${escape(result.case)} rendered by ${escape(result.contender)}" src="data:image/png;base64,${shot.toString("base64")}">`
  }</figure>
  ${result.failure === undefined ? "" : `<p class="failure">${escape(result.failure)}</p>`}
  ${clientOnlyNote(result.islands, result.clientOnly)}
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
figure{margin:16px 0 0;background:var(--page);border:1px solid var(--line);border-radius:8px;overflow:hidden}
img{display:block;width:100%}
.blank{padding:48px 16px;text-align:center;font-size:13px;color:var(--ter)}
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

/** One self-contained page per run: the screenshots side by side, each under its
 *  own floor verdicts and numbers. Images are inlined, so the file can be moved
 *  or attached anywhere and still render. */
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
