#!/usr/bin/env node
/**
 * execution-v2 Wave 7 H2 — live box build-speed profile (item 3).
 *
 * Boots a box from a built template, runs ONE layer-3 (served kanban) box
 * edit against real Claude, and prints a phase profile parsed from the
 * ISO-stamped agent log (harness.mjs): boot, per-step model latency, tool
 * (bash/write) time, npm-install time, self-test time. Used to measure the
 * baseline template vs. the pre-baked served-app scaffold.
 *
 *   node --env-file /path/to/.env measure-box-build.mjs --template <id> --label baseline
 *
 * Requires E2B_API_KEY + ANTHROPIC_API_KEY. Kills its sandbox on exit.
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
if (!template) throw new Error("--template <id> is required");
if (!process.env.E2B_API_KEY || !process.env.ANTHROPIC_API_KEY) {
  throw new Error("E2B_API_KEY and ANTHROPIC_API_KEY must be set (use node --env-file)");
}

const CONTROL_PORT = 8811;
const APP_PORT = 8080;

// Mirrors runtime.ts skinContractPrompt + servedAppContractPrompt, minus the
// host callback surfaces (this is a build-speed profile, not a host gate):
// working data stays in memory so the build shape (codegen + self-test) is
// identical without a tunnel.
const CONTEXT = [
  "SKIN CONTRACT (the box boundary you build against):",
  "- Listen on the PORT env var. Serve POST /fn/<name> answering {\"result\": ...} (or {\"error\":{\"code\",\"message\"}}), and GET /vendo.json returning the manifest file.",
  "- Manifest vendo.json: {\"schedules\":[...], \"egress\":[...]}. Declare EVERY third-party domain you fetch; undeclared egress is blocked at the network layer.",
  "- .vendo/run holds ONE shell line that starts the app (e.g. \"node server.js\"). Write it; a supervisor runs it.",
  "- For THIS build keep working data in process memory seeded with a few sample invoices (no store callbacks are wired).",
  "THIS TASK BUILDS THE APP SURFACE ITSELF (layer 3):",
  "- START WARM: a served-app scaffold is pre-baked at /opt/vendo-box/scaffold (zero-dep Node server with the /fn envelopes, vendo.json serving, a themed entry page, and the .vendo/run entry already wired and tested). Your FIRST action: run exactly `cp -a /opt/vendo-box/scaffold/. /app/` (one command; it copies .vendo/run too — no ls, no second cp), then go straight to editing fns.js + index.html (touch server.js only for extra routes). Only if that cp fails (older box) build from scratch.",
  "- Serve a REAL web app on the non-/fn paths of $PORT. GET / is the entry page and must answer 200 with text/html. Any framework or plain HTML+JS; keep it self-contained (no CDN dependencies unless their domains are declared egress).",
  "- Keep every POST /fn/<name> endpoint working beside the pages; the page's own JavaScript may call relative /fn/<name> endpoints for data and actions.",
  "- The page may read the OPTIONAL `vendoTheme` query param (JSON host theme tokens: colors/typography/radius/density) to match the host brand. Ignore it if absent.",
  "- Verify by curling your own pages (GET / and every route you serve) until they answer 200 with the real content, then report servesUi: true.",
].join("\n");

const PROMPT = "Rebuild this as a full web app: a kanban board for my invoices with drag-and-drop between columns (Draft / Sent / Paid), moving a card updates its status server-side.";

const startedAt = Date.now();
const stamp = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
console.log(`[${label}] creating sandbox from ${template}…`);

const sandbox = await Sandbox.create(template, { timeoutMs: 30 * 60_000 });
const host = (port) => `https://${sandbox.getHost(port)}`;

try {
  // Boot: template start command waits for the control port, but measure our
  // own first-success anyway.
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

  // The production env door (pushBoxEnv): the harness's boot process never
  // sees Sandbox.create envs, only env.json re-injection.
  const injected = await fetch(`${host(CONTROL_PORT)}/agent/env`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      env: {
        PORT: String(APP_PORT),
        VENDO_INFERENCE_URL: "https://api.anthropic.com",
        VENDO_INFERENCE_KEY: process.env.ANTHROPIC_API_KEY,
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

  // The served-root check the host would run.
  const root = await fetch(`${host(APP_PORT)}/`);
  console.log(`[${label}] GET / → ${root.status} ${root.headers.get("content-type")}`);

  // Full ISO-stamped agent log → phase profile.
  const raw = new TextDecoder().decode(await sandbox.files.read(`/app/.vendo/agent-${taskId}.log`, { format: "bytes" }));
  const logPath = path.join(here, `agent-log-${label}.txt`);
  writeFileSync(logPath, raw);
  const lines = raw.split("\n").filter((line) => /^\d{4}-/.test(line));
  const entries = lines.map((line) => {
    const ts = Date.parse(line.slice(0, line.indexOf(" ")));
    const rest = line.slice(line.indexOf(" ") + 1);
    return { ts, rest };
  });
  const buckets = { model: 0, bash: 0, "npm-install": 0, other: 0 };
  let steps = 0;
  for (let i = 0; i < entries.length - 1; i += 1) {
    const delta = entries[i + 1].ts - entries[i].ts;
    const text = entries[i].rest;
    if (text.startsWith("[bash]")) {
      buckets[/npm (i|install|ci)\b/.test(text) ? "npm-install" : "bash"] += delta;
    } else if (text.startsWith("[assistant]") || text.startsWith("[write]") || text.startsWith("[task] model=")) {
      // The gap after an assistant/write/first line is the next model call.
      buckets.model += delta;
      if (text.startsWith("[assistant]")) steps += 1;
    } else {
      buckets.other += delta;
    }
  }
  console.log(`[${label}] phase profile over ${entries.length} log lines (~${steps} assistant turns):`);
  for (const [bucket, ms] of Object.entries(buckets)) {
    console.log(`  ${bucket.padEnd(12)} ${(ms / 1000).toFixed(1)}s (${((ms / buildMs) * 100).toFixed(0)}%)`);
  }
  console.log(`[${label}] full log: ${logPath}`);
} finally {
  await sandbox.kill().catch(() => undefined);
  console.log(`[${label}] sandbox killed (${stamp()})`);
}
