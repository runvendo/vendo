/**
 * Re-gate half-runner (2026-07-26): drives one host's 15 T5 prompts x 3 arms through
 * the real Apps create path, switching the candidate arm (VENDO_GATE_ARM env,
 * server restart) per the committed randomized schedule. Resumable: rows
 * already in results.tsv are skipped. Sequential creates; the host server log
 * (server-<arm-session>.log) carries the onPipeline JSON lines per create.
 *
 * Usage: node run-half.mjs <maple|cadence> <repoDir> <runDir>
 * Env: MAPLE_DEMO_PASSWORD/AUTH_SECRET or SUPABASE_JWT_SECRET must match the
 * booted server; ANTHROPIC_API_KEY etc. ride the server env file.
 */
import { spawn, execSync, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , host, repoDir, runDir] = process.argv;
if (!["maple", "cadence"].includes(host) || !repoDir || !runDir) {
  console.error("usage: node run-half.mjs <maple|cadence> <repoDir> <runDir>");
  process.exit(2);
}

const PORT = host === "maple" ? 3100 : 3300; // 3000/3200 occupied by another session on this machine
const APP_DIR = join(repoDir, "apps", host === "maple" ? "demo-bank" : "demo-accounting");
const DRIVER = join(runDir, "driver.mjs");
const TSV = join(runDir, `results-${host}.tsv`);
const LOGS = join(runDir, "server-logs");
mkdirSync(LOGS, { recursive: true });

const SCHEDULE = JSON.parse(readFileSync(join(runDir, "arm-schedule.json"), "utf8"));
const PROMPTS = JSON.parse(readFileSync(join(runDir, "prompts.json"), "utf8"));
const ids = Object.keys(PROMPTS).filter((id) =>
  host === "maple" ? Number(id.slice(1)) <= 15 : Number(id.slice(1)) >= 16);

const done = new Set(
  existsSync(TSV)
    ? readFileSync(TSV, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t").slice(0, 2).join(":"))
    : [],
);
if (!existsSync(TSV)) writeFileSync(TSV, "");

let serverProc = null;
let currentArm = null;
let logFile = null;

function killPort() {
  // LISTEN sockets only: a plain `lsof -ti tcp:PORT` also lists CLIENTS with
  // pooled keep-alive connections — including this runner (waitReady fetches)
  // — and kill -9'ing the list killed the runner itself on the first switch.
  try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore", shell: "/bin/zsh" }); } catch {}
}

async function waitReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("server did not become ready");
}

async function bootArm(arm) {
  if (currentArm === arm && serverProc && serverProc.exitCode === null) return;
  if (serverProc) { try { serverProc.kill("SIGKILL"); } catch {} }
  killPort();
  await new Promise((res) => setTimeout(res, 1500));
  logFile = join(LOGS, `${host}-arm${arm}-${Date.now()}.log`);
  const env = {
    ...process.env,
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=3072",
    PORT: String(PORT),
    VENDO_GATE_ARM: arm,
    VENDO_BASE_URL: `http://localhost:${PORT}`,
  };
  appendFileSync(logFile, `=== boot ${host} arm ${arm} at ${new Date().toISOString()} ===\n`);
  serverProc = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (d) => appendFileSync(logFile, d));
  serverProc.stderr.on("data", (d) => appendFileSync(logFile, d));
  await waitReady();
  currentArm = arm;
  console.log(`[runner] ${host} serving arm ${arm} on :${PORT} (log ${logFile})`);
}

function markerLine(text) { appendFileSync(logFile, `\n=== ${text} ===\n`); }

function runDriver(args) {
  // execFileSync with an argument array: no shell, so prompt text with $
  // amounts, quotes, or backticks is passed through verbatim.
  try {
    return execFileSync("node", [DRIVER, ...args], {
      encoding: "utf8", timeout: 900_000, env: process.env,
    });
  } catch (error) {
    return `DRIVER-ERROR: ${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message}`;
  }
}

for (const id of ids) {
  const order = SCHEDULE[id].split("");
  for (const arm of order) {
    const key = `${id}:${arm}`;
    if (done.has(key)) { console.log(`[runner] skip ${key} (done)`); continue; }
    await bootArm(arm);
    markerLine(`create ${id} arm ${arm} start`);
    const label = `${id}-${arm}`;
    const out = runDriver(["create", host, label, PROMPTS[id]]);
    markerLine(`create ${id} arm ${arm} end`);
    const appId = /appId: (\S+)/.exec(out)?.[1] ?? "UNKNOWN";
    const name = /name: (.*)/.exec(out)?.[1] ?? "?";
    const timing = /timing: ([\d.]+)/.exec(out)?.[1] ?? "?";
    const consoleErrors = /console-errors: (\d+)/.exec(out)?.[1] ?? "?";
    appendFileSync(TSV, `${id}\t${arm}\t${appId}\t${name}\t${timing}\t${consoleErrors}\t${logFile}\n`);
    console.log(`[runner] ${key}: app=${appId} timing=${timing}s errors=${consoleErrors}`);
    if (out.startsWith("DRIVER-ERROR")) console.log(out.slice(0, 800));
  }
}

if (serverProc) { try { serverProc.kill("SIGKILL"); } catch {} }
killPort();
console.log("[runner] half complete");
