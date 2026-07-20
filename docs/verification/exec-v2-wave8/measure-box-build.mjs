#!/usr/bin/env node
/**
 * execution-v2 Wave 8 — same-prompt A/B: thin loop (Wave 3-7 engine) vs the
 * Claude Agent SDK in the box.
 *
 * Boots a box from a built template and runs ONE box edit against real
 * Claude, printing wall-clock build time + the structured result + a phase
 * profile parsed from the ISO-stamped agent log. Run it against a thin-loop
 * template (built from main's agent-loop.mjs) and the Wave-8 SDK template
 * with the SAME prompt to A/B the engines.
 *
 *   node measure-box-build.mjs --template <id> --label sdk-l3 --mode layer3
 *   node measure-box-build.mjs --template <id> --label sdk-grad --mode graduation
 *
 * Modes:
 *   layer3      — the Wave-7 kanban served-app build (identical prompt to
 *                 docs/verification/exec-v2-wave7-h2/measure-box-build.mjs,
 *                 so Wave-7 numbers are directly comparable).
 *   graduation  — the Wave-3 invoice-chaser 2-fn server build (fn-only).
 *
 * Requires E2B_API_KEY + ANTHROPIC_API_KEY (+ optional VENDO_INFERENCE_MODEL).
 * Kills its sandbox on exit.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../packages/apps/package.json"));
const { Sandbox } = await import(require.resolve("e2b"));

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const template = arg("template");
const label = arg("label", "run");
const mode = arg("mode", "layer3");
if (!template) throw new Error("--template <id> is required");
if (!process.env.E2B_API_KEY || !process.env.ANTHROPIC_API_KEY) {
  throw new Error("E2B_API_KEY and ANTHROPIC_API_KEY must be set");
}

const CONTROL_PORT = 8811;
const APP_PORT = 8080;

const SKIN = [
  "SKIN CONTRACT (the box boundary you build against):",
  "- Listen on the PORT env var. Serve POST /fn/<name> answering {\"result\": ...} (or {\"error\":{\"code\",\"message\"}}), and GET /vendo.json returning the manifest file.",
  "- Manifest vendo.json: {\"schedules\":[...], \"egress\":[...]}. Declare EVERY third-party domain you fetch; undeclared egress is blocked at the network layer.",
  "- .vendo/run holds ONE shell line that starts the app (e.g. \"node server.js\"). Write it; a supervisor runs it.",
  "- For THIS build keep working data in process memory seeded with a few sample invoices (no store callbacks are wired).",
];

// Verbatim from the Wave-7 measure script so the numbers stay comparable.
const LAYER3_CONTEXT = [
  ...SKIN,
  "THIS TASK BUILDS THE APP SURFACE ITSELF (layer 3):",
  "- START WARM: a served-app scaffold is pre-baked at /opt/vendo-box/scaffold (zero-dep Node server with the /fn envelopes, vendo.json serving, a themed entry page, and the .vendo/run entry already wired and tested). Your FIRST action: run exactly `cp -a /opt/vendo-box/scaffold/. /app/` (one command; it copies .vendo/run too — no ls, no second cp), then go straight to editing fns.js + index.html (touch server.js only for extra routes). Only if that cp fails (older box) build from scratch.",
  "- Serve a REAL web app on the non-/fn paths of $PORT. GET / is the entry page and must answer 200 with text/html. Any framework or plain HTML+JS; keep it self-contained (no CDN dependencies unless their domains are declared egress).",
  "- Keep every POST /fn/<name> endpoint working beside the pages; the page's own JavaScript may call relative /fn/<name> endpoints for data and actions.",
  "- The page may read the OPTIONAL `vendoTheme` query param (JSON host theme tokens: colors/typography/radius/density) to match the host brand. Ignore it if absent.",
  "- Verify by curling your own pages (GET / and every route you serve) until they answer 200 with the real content, then report servesUi: true.",
].join("\n");
const LAYER3_PROMPT = "Rebuild this as a full web app: a kanban board for my invoices with drag-and-drop between columns (Draft / Sent / Paid), moving a card updates its status server-side.";

// The Wave-3 invoice-chaser graduation shape (fn-only server, schedule +
// egress declaration), host callbacks stubbed to memory exactly like layer3.
const GRADUATION_CONTEXT = SKIN.join("\n");
const GRADUATION_PROMPT = [
  "Watch my unpaid invoices and email me a digest every morning at 8am, and show the latest digest on the status board.",
  "Build a zero-dependency Node server:",
  "- POST /fn/chaseInvoices: compute a digest of the sample invoices (count + totalCents + the invoice list), POST it as JSON to https://httpbin.org/post (declare the egress), and keep the digest in memory as the latest.",
  "- POST /fn/getDigest: return the latest stored digest (or the freshly computed one if none stored yet).",
  "- vendo.json: declare the 8am daily schedule for chaseInvoices and the httpbin.org egress.",
  "Verify both fns answer correctly on http://localhost:$PORT before reporting.",
].join("\n");

const CONTEXT = mode === "layer3" ? LAYER3_CONTEXT : GRADUATION_CONTEXT;
const PROMPT = mode === "layer3" ? LAYER3_PROMPT : GRADUATION_PROMPT;

const startedAt = Date.now();
const stamp = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
console.log(`[${label}] mode=${mode} creating sandbox from ${template}…`);

const sandbox = await Sandbox.create(template, { timeoutMs: 30 * 60_000 });
const host = (port) => `https://${sandbox.getHost(port)}`;

try {
  let bootMs;
  for (let i = 0; i < 120; i += 1) {
    try {
      const health = await fetch(`${host(CONTROL_PORT)}/agent/health`);
      if (health.ok) { bootMs = Date.now() - startedAt; break; }
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (bootMs === undefined) throw new Error("control port never came up");
  console.log(`[${label}] boot→control-port: ${(bootMs / 1000).toFixed(1)}s`);

  const injected = await fetch(`${host(CONTROL_PORT)}/agent/env`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      env: {
        PORT: String(APP_PORT),
        VENDO_INFERENCE_URL: process.env.VENDO_INFERENCE_URL ?? "https://api.anthropic.com",
        VENDO_INFERENCE_KEY: process.env.VENDO_INFERENCE_KEY ?? process.env.ANTHROPIC_API_KEY,
        ...(process.env.VENDO_INFERENCE_MODEL ? { VENDO_INFERENCE_MODEL: process.env.VENDO_INFERENCE_MODEL } : {}),
      },
    }),
  });
  if (!injected.ok) throw new Error(`env injection failed: ${injected.status}`);

  const taskStarted = Date.now();
  const started = await fetch(`${host(CONTROL_PORT)}/agent/task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: PROMPT, context: CONTEXT }),
  });
  if (started.status !== 202) throw new Error(`task refused: ${started.status} ${await started.text()}`);
  const { taskId } = await started.json();
  console.log(`[${label}] task ${taskId} started (${stamp()})`);

  let result;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const polled = await (await fetch(`${host(CONTROL_PORT)}/agent/task/${taskId}`)).json();
    if (polled.status === "done") { result = polled.result; break; }
    process.stdout.write(".");
  }
  console.log("");
  const buildMs = Date.now() - taskStarted;
  if (result === undefined) throw new Error("task did not finish within 15 min");
  console.log(`[${label}] BUILD ${(buildMs / 1000).toFixed(1)}s ok=${result.ok} servesUi=${result.servesUi === true} fns=${(result.fns ?? []).join(",")}`);
  console.log(`[${label}] summary: ${result.summary}`);

  if (mode === "layer3") {
    const root = await fetch(`${host(APP_PORT)}/`);
    console.log(`[${label}] GET / → ${root.status} ${root.headers.get("content-type")}`);
  } else {
    const digest = await fetch(`${host(APP_PORT)}/fn/getDigest`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: {} }),
    });
    const payload = await digest.text();
    console.log(`[${label}] POST /fn/getDigest → ${digest.status} ${payload.slice(0, 300)}`);
  }

  const raw = new TextDecoder().decode(await sandbox.files.read(`/app/.vendo/agent-${taskId}.log`, { format: "bytes" }));
  const logPath = path.join(here, `agent-log-${label}.txt`);
  writeFileSync(logPath, raw);
  const lines = raw.split("\n").filter((line) => /^\d{4}-/.test(line));
  const entries = lines.map((line) => ({
    ts: Date.parse(line.slice(0, line.indexOf(" "))),
    rest: line.slice(line.indexOf(" ") + 1),
  }));
  // Directional buckets (same caveat as Wave 7: a line's delta includes the
  // following model call's latency; BUILD wall clock is the honest number).
  const buckets = { model: 0, bash: 0, "npm-install": 0, other: 0 };
  let turns = 0;
  for (let i = 0; i < entries.length - 1; i += 1) {
    const delta = entries[i + 1].ts - entries[i].ts;
    const text = entries[i].rest;
    if (text.startsWith("[bash]")) {
      buckets[/npm (i|install|ci)\b/.test(text) ? "npm-install" : "bash"] += delta;
    } else if (text.startsWith("[assistant]") || text.startsWith("[write]") || text.startsWith("[task]")) {
      buckets.model += delta;
      if (text.startsWith("[assistant]")) turns += 1;
    } else {
      buckets.other += delta;
    }
  }
  console.log(`[${label}] phase profile over ${entries.length} log lines (~${turns} assistant turns):`);
  for (const [bucket, ms] of Object.entries(buckets)) {
    console.log(`  ${bucket.padEnd(12)} ${(ms / 1000).toFixed(1)}s (${((ms / buildMs) * 100).toFixed(0)}%)`);
  }
  console.log(`[${label}] full log: ${logPath}`);
} finally {
  await sandbox.kill().catch(() => undefined);
  console.log(`[${label}] sandbox killed (${stamp()})`);
}
