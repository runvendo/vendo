/**
 * SPIKE runner — Codex app-server rider on the machine's ChatGPT-plan login.
 * No OPENAI_API_KEY is used; auth comes from ~/.codex/auth.json (read-only).
 */
import { CodexRider } from "./codex-rider.js";
import { appendResults, summarize, type TurnMetrics } from "./metrics.js";
import { APPROVAL_DELAY_MS, SCENARIOS, TRIALS } from "./scenarios.js";

delete process.env.OPENAI_API_KEY;

const rider = new CodexRider();
const { spawnMs, model } = await rider.start();
console.log(`codex rider up in ${spawnMs.toFixed(0)}ms, model=${model}`);

const rows: TurnMetrics[] = [];
const rung = `codex-app-server (${model ?? "?"})`;

for (let trial = 1; trial <= TRIALS; trial++) {
  const m = await rider.sendTurn(SCENARIOS.short);
  rows.push({ rung, scenario: "short", trial, ...m });
  console.log(`short #${trial}: ttft=${m.ttftMs?.toFixed(0)}ms total=${m.totalMs.toFixed(0)}ms "${(m.answer ?? "").slice(0, 40)}"`);
}
for (let trial = 1; trial <= TRIALS; trial++) {
  const m = await rider.sendTurn(SCENARIOS.toolRead);
  rows.push({ rung, scenario: "tool-read", trial, ...m });
  console.log(`tool-read #${trial}: ttft=${m.ttftMs?.toFixed(0)}ms total=${m.totalMs.toFixed(0)}ms ${m.notes ?? ""}`);
}
rider.approvalDelayMs = APPROVAL_DELAY_MS;
for (let trial = 1; trial <= 2; trial++) {
  const m = await rider.sendTurn(SCENARIOS.toolApprove);
  rows.push({ rung, scenario: `tool-approve(+${APPROVAL_DELAY_MS}ms park)`, trial, ...m });
  console.log(`tool-approve #${trial}: total=${m.totalMs.toFixed(0)}ms ${m.notes ?? ""} "${(m.answer ?? "").slice(0, 80)}"`);
}

console.log("\napproval broker log:");
for (const e of rider.broker.log) console.log(`  ${e.event} ${e.detail ?? ""} @${e.at}`);

await rider.dispose();
await appendResults(new URL("../results/latency.json", import.meta.url).pathname, rows);
console.log(`\n${summarize(rows)}`);
process.exit(0);
