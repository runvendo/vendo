#!/usr/bin/env node
/**
 * ENG-338 E2E rung runner: starts the clean-room app's dev server with the
 * given env, waits for /api/vendo/status, POSTs one chat turn, prints the
 * streamed reply, and shuts down. Usage:
 *   node run-rung.mjs <rung-label> <prompt>
 * Env is inherited (the caller pins the rung via ANTHROPIC_API_KEY /
 * VENDO_DEV_CREDENTIAL / VENDO_DEV_ALLOW_SESSIONS).
 */
import { spawn } from "node:child_process";

const [label, prompt = "Introduce yourself in one short sentence."] = process.argv.slice(2);
const APP = "/tmp/eng338-e2e/app";
const PORT = process.env.PORT ?? "3400";
const BASE = `http://localhost:${PORT}`;

const child = spawn("npm", ["run", "dev", "--", "--port", PORT], {
  cwd: APP,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env },
});
const serverLog = [];
child.stdout.on("data", (d) => serverLog.push(d.toString()));
child.stderr.on("data", (d) => serverLog.push(d.toString()));

const deadline = Date.now() + 120_000;
let up = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${BASE}/api/vendo/status`);
    if (res.ok) { up = true; break; }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 750));
}
if (!up) {
  console.error(`[${label}] dev server never answered /status. Log tail:\n${serverLog.slice(-30).join("")}`);
  child.kill("SIGTERM");
  process.exit(1);
}
console.log(`[${label}] dev server up at ${BASE}`);

const started = Date.now();
let reply = "";
let sawError = null;
const parts = [];
try {
  const res = await fetch(`${BASE}/api/vendo/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { id: `msg_e2e_${Date.now()}`, role: "user", parts: [{ type: "text", text: prompt }] },
    }),
  });
  console.log(`[${label}] POST /threads → ${res.status}; thread=${res.headers.get("x-vendo-thread-id")}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (!frame.startsWith("data: ") || frame === "data: [DONE]") continue;
      const part = JSON.parse(frame.slice(6));
      parts.push(part.type);
      if (part.type === "text-delta") reply += part.delta;
      if (part.type === "error") sawError = part.errorText;
    }
  }
} catch (error) {
  sawError = String(error);
}
const ms = Date.now() - started;

console.log(`[${label}] turn ${ms}ms; parts=[${[...new Set(parts)].join(",")}]`);
if (reply) console.log(`[${label}] REPLY: ${reply}`);
if (sawError) console.log(`[${label}] ERROR PART: ${sawError}`);
// Server-side log lines mentioning the ladder (the honest-failure evidence).
const ladderLines = serverLog.join("").split("\n").filter((l) => l.includes("[vendo]"));
if (ladderLines.length > 0) console.log(`[${label}] server log:\n${ladderLines.join("\n")}`);

child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
