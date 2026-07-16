#!/usr/bin/env node
/**
 * Wave 6b (ENG-239) — anonymous-session churn drill against the wave-4
 * session lifecycle (ENG-237: TTL registry + LRU cap eviction, PR #301).
 *
 * Drives N cookie-less requests at the Vendo wire. Every request without a
 * `vendo_anon_session` cookie mints a FRESH anonymous principal and registers
 * it in the ephemeral-session registry (packages/vendo/src/server.ts context()),
 * so N requests == N anonymous sessions churned. The script:
 *
 *   1. finds the dev-server process(es) listening on the target port,
 *   2. fires the churn with bounded concurrency, asserting each response is
 *      200 AND carries a fresh anon Set-Cookie (proof a session was minted),
 *   3. samples the summed process RSS every `sampleEvery` sessions,
 *   4. after the churn, keeps sampling through one TTL+sweep window so the
 *      idle sweep's effect is visible too.
 *
 * Memory staying flat while sessions-created grows unboundedly is the beat's
 * evidence: the registry is a bounded LRU (sessions.maxSessions) + TTL sweep,
 * so churned sessions are evicted, not accumulated.
 *
 * Usage:
 *   node session-churn.mjs [--base http://localhost:3000] [--sessions 5000]
 *     [--concurrency 25] [--sample-every 250] [--settle-seconds 90]
 */
import { execFileSync } from "node:child_process";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const base = arg("base", "http://localhost:3000");
const totalSessions = Number(arg("sessions", 5000));
const concurrency = Number(arg("concurrency", 25));
const sampleEvery = Number(arg("sample-every", 250));
const settleSeconds = Number(arg("settle-seconds", 90));
const port = Number(new URL(base).port || 80);

function serverPids() {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
    return [...new Set(out.split("\n").filter(Boolean).map(Number))];
  } catch {
    return [];
  }
}

function rssMb(pids) {
  if (pids.length === 0) return NaN;
  const out = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
  const kb = out.split("\n").filter(Boolean).reduce((sum, line) => sum + Number(line.trim()), 0);
  return Math.round((kb / 1024) * 10) / 10;
}

const pids = serverPids();
if (pids.length === 0) {
  console.error(`no process listening on :${port} — start the dev server first`);
  process.exit(1);
}
console.log(`[churn] target=${base} sessions=${totalSessions} concurrency=${concurrency}`);
console.log(`[churn] server pid(s) on :${port}: ${pids.join(", ")}`);
console.log(`[churn] columns: sessions_created  rss_mb`);

let created = 0;
let cookieMisses = 0;
let failures = 0;
const samples = [];

function sample(label) {
  const row = { sessions: created, rssMb: rssMb(serverPids()), label };
  samples.push(row);
  console.log(`${String(row.sessions).padStart(8)}  ${String(row.rssMb).padStart(8)}${label ? `  # ${label}` : ""}`);
}

async function churnOne() {
  let response;
  try {
    response = await fetch(`${base}/api/vendo/threads`, {
      headers: { accept: "application/json" },
    });
    await response.arrayBuffer();
  } catch {
    // Transient socket resets under dev-server saturation count as failures,
    // they must not abort the drill.
    failures += 1;
    return;
  }
  if (response.status !== 200) {
    failures += 1;
    return;
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  if (!setCookie.includes("vendo_anon_session")) cookieMisses += 1;
  created += 1;
  if (created % sampleEvery === 0) sample();
}

sample("before churn");
const started = Date.now();
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < totalSessions) {
      next += 1;
      await churnOne();
    }
  }),
);
const elapsed = Math.round((Date.now() - started) / 1000);
sample("churn complete");
console.log(`[churn] ${created} sessions in ${elapsed}s, ${failures} failures, ${cookieMisses} responses without a fresh anon cookie`);

console.log(`[churn] settling ${settleSeconds}s (TTL + sweep window), sampling every 15s...`);
for (let waited = 0; waited < settleSeconds; waited += 15) {
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  sample(`settle +${waited + 15}s`);
}

const peak = Math.max(...samples.map((row) => row.rssMb));
const first = samples[0].rssMb;
const last = samples[samples.length - 1].rssMb;
console.log(`[churn] rss_mb before=${first} peak=${peak} after-settle=${last}`);
