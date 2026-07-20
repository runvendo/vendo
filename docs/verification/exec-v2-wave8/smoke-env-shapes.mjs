#!/usr/bin/env node
/**
 * execution-v2 Wave 8 — verify BOTH inference env shapes run the Claude Agent
 * SDK headless in-sandbox (the Wave-3 friction, solved properly):
 *
 *   byo      VENDO_INFERENCE_URL=https://api.anthropic.com + an sk-ant key
 *            → the SDK's ANTHROPIC_API_KEY path.
 *   gateway  VENDO_INFERENCE_URL=<console>/api/v1 + VENDO_API_KEY
 *            → the SDK's ANTHROPIC_BASE_URL override pointed at the Vendo
 *            Cloud Anthropic-compatible model gateway.
 *
 *   node smoke-env-shapes.mjs --template <id> --shape byo|gateway
 *
 * Requires E2B_API_KEY, plus ANTHROPIC_API_KEY (byo) or VENDO_API_KEY
 * (gateway). Runs one tiny fn task and asserts a structured ok:true result.
 * Kills its sandbox on exit.
 */
import { createRequire } from "node:module";
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
const shape = arg("shape", "byo");
if (!template) throw new Error("--template <id> is required");
if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY must be set");

const inference = shape === "gateway"
  ? {
      VENDO_INFERENCE_URL: `${(process.env.VENDO_CLOUD_URL ?? "https://console.vendo.run").replace(/\/$/, "")}/api/v1`,
      VENDO_INFERENCE_KEY: process.env.VENDO_API_KEY ?? (() => { throw new Error("VENDO_API_KEY must be set for --shape gateway"); })(),
    }
  : {
      VENDO_INFERENCE_URL: "https://api.anthropic.com",
      VENDO_INFERENCE_KEY: process.env.ANTHROPIC_API_KEY ?? (() => { throw new Error("ANTHROPIC_API_KEY must be set for --shape byo"); })(),
    };

const CONTROL_PORT = 8811;
const APP_PORT = 8080;
const PROMPT = "Write a tiny zero-dependency Node server: POST /fn/ping answers {\"result\":{\"pong\":true}} and GET /vendo.json serves an empty manifest {}. Write vendo.json and .vendo/run, restart the app via the supervisor, verify /fn/ping answers on http://localhost:$PORT, then report done with fns=[\"ping\"].";

console.log(`[${shape}] creating sandbox from ${template}…`);
const startedAt = Date.now();
const sandbox = await Sandbox.create(template, { timeoutMs: 15 * 60_000 });
const host = (port) => `https://${sandbox.getHost(port)}`;

try {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${host(CONTROL_PORT)}/agent/health`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const injected = await fetch(`${host(CONTROL_PORT)}/agent/env`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ env: { PORT: String(APP_PORT), ...inference } }),
  });
  if (!injected.ok) throw new Error(`env injection failed: ${injected.status}`);

  const started = await fetch(`${host(CONTROL_PORT)}/agent/task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: PROMPT }),
  });
  if (started.status !== 202) throw new Error(`task refused: ${started.status}`);
  const { taskId } = await started.json();

  let result;
  let log = "";
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const polled = await (await fetch(`${host(CONTROL_PORT)}/agent/task/${taskId}`)).json();
    log = polled.log ?? log;
    if (polled.status === "done") { result = polled.result; break; }
    process.stdout.write(".");
  }
  console.log("");
  if (result === undefined) throw new Error(`[${shape}] task did not finish; log tail:\n${log}`);
  console.log(`[${shape}] result: ${JSON.stringify(result, null, 2)}`);

  const ping = await fetch(`${host(APP_PORT)}/fn/ping`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: {} }),
  });
  const body = await ping.text();
  console.log(`[${shape}] POST /fn/ping → ${ping.status} ${body}`);

  const pass = result.ok === true && ping.status === 200 && body.includes("pong");
  console.log(`[${shape}] ${pass ? "PASS" : "FAIL"} (${((Date.now() - startedAt) / 1000).toFixed(1)}s total)`);
  if (!pass) {
    console.log(`[${shape}] agent log tail:\n${log}`);
    process.exitCode = 1;
  }
} finally {
  await sandbox.kill().catch(() => undefined);
  console.log(`[${shape}] sandbox killed`);
}
