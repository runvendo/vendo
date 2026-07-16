/** SPIKE runner — env-key baseline. Requires ANTHROPIC_API_KEY. */
import { baselineTurn } from "./baseline.js";
import { appendResults, summarize, type TurnMetrics } from "./metrics.js";
import { SCENARIOS, TRIALS } from "./scenarios.js";

const MODEL = process.env.BASELINE_MODEL ?? "claude-opus-4-8";

const rows: TurnMetrics[] = [];
for (let trial = 1; trial <= TRIALS; trial++) {
  const m = await baselineTurn(SCENARIOS.short, MODEL);
  rows.push({ rung: `env-key ${MODEL}`, scenario: "short", trial, ...m });
  console.log(`baseline short #${trial}: ttft=${m.ttftMs?.toFixed(0)}ms total=${m.totalMs.toFixed(0)}ms "${(m.answer ?? "").slice(0, 40)}"`);
}
await appendResults(new URL("../results/latency.json", import.meta.url).pathname, rows);
console.log(`\n${summarize(rows)}`);
