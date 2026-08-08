import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checks, type Binding, type Offender } from "./floor.js";
import type { CaseResult } from "./run.js";
import { cannedResponse, type World } from "./world.js";

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const verdict = (ok: boolean): string =>
  `<span class="v ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${ok ? "pass" : "fail"}</span>`;

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
            `<li><code>${escape(b.where)}</code> <span>${[b.tool, b.why]
              .filter((part) => part !== undefined)
              .map(escape)
              .join(" — ")}</span> ${b.known && b.argsValid ? '<i class="ok">✓</i>' : '<i class="no">✕</i>'}</li>`,
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
  const scored = checks(result.floor);
  const total = scored.filter((check) => check.pass).length;
  const { usage } = result.cost;
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

  return `<section class="col">
  <header>
    <div><h2>${escape(result.contender)}</h2><p>${escape(result.model)}</p></div>
    <span class="score ${total === scored.length ? "ok" : "no"}">${total}/${scored.length}</span>
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
  <dl class="floor">${scored.map((check) => `<div><dt>${check.name}</dt><dd>${verdict(check.pass)}</dd></div>`).join("")}</dl>
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

async function caseSection(runDir: string, testCase: string, results: readonly CaseResult[], world: World | undefined): Promise<string> {
  const columns = await Promise.all(results.map(async (result) => await column(runDir, result)));
  return `<section class="case">
  <p class="case-id">${escape(testCase)}</p>
  <h2 class="prompt">${escape(results[0]?.prompt ?? "")}</h2>
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
/* Room for the fixed call feed, so the last column is never hidden under it. */
.wrap{max-width:1240px;margin:0 auto;padding:32px 24px calc(var(--feed) + 32px)}
h1{margin:0;font-size:28px;font-weight:600;letter-spacing:-.02em}
.meta{margin:16px 0 0;font:450 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.meta span+span::before{content:"·";margin:0 8px;color:var(--line)}
/* The prompt is the heading a person reads; the case id is a filename. */
.case{margin-top:48px}
.case-id{margin:0;font:450 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ter)}
.prompt{margin:10px 0 0;font-size:20px;font-weight:500;line-height:1.35;letter-spacing:-.01em;max-width:62ch}
/* Capped, not fluid: the screenshots are shot at a fixed 480px, so letting a
   single column stretch to the full page would upscale and blur the one
   artifact the whole page exists to show. */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,540px));gap:24px;margin-top:24px;justify-content:center}
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
 * No server, no shared state: the file works from disk, offline, forever.
 */
const FEED_SCRIPT = `
addEventListener("message", function (event) {
  var call = event.data;
  if (call === null || typeof call !== "object" || call.genbench !== "call") return;
  var row = document.createElement("li");
  var when = document.createElement("time");
  when.textContent = new Date(call.ts).toLocaleTimeString("en-US", { hour12: false });
  var who = document.createElement("span");
  who.className = "who";
  who.textContent = call.contender;
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
${sections.join("")}
</div>
<aside class="feed"><p class="feed-label">tool calls</p><ol id="feed"></ol></aside>
<script>${FEED_SCRIPT}</script>
</body></html>`;
  const path = join(input.runDir, "preview.html");
  await writeFile(path, html);
  return path;
}
