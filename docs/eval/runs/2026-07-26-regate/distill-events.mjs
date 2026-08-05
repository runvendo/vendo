/**
 * Re-gate pipeline-event distiller: reads the half's server logs and produces
 * one JSON record per create (id+arm) with the mechanism telemetry the run
 * README reports: pipeline stage lines (repair rounds, end-pass/data-verify,
 * island-repair), lane timing lines (paint-lane presence = paint-model parity
 * evidence), the smoke-render environment-skip warning, and the server-side
 * refusal conclusion (`app build failed` + its issue bullets).
 *
 * Attribution: lines between `=== create <id> arm <arm> start ===` and the
 * NEXT create's start marker belong to that create (late-landing conclusions
 * after the end marker are attributed to the create that produced them; boots
 * reset attribution).
 *
 * Usage: node distill-events.mjs <server-logs-dir> <host> > pipeline-events-<host>.json
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [, , logsDir, host] = process.argv;
if (!logsDir || !host) {
  console.error("usage: node distill-events.mjs <server-logs-dir> <host>");
  process.exit(2);
}

const records = {};
const key = (id, arm) => `${id}:${arm}`;

const files = readdirSync(logsDir).filter((f) => f.startsWith(`${host}-arm`) && f.endsWith(".log")).sort();
for (const file of files) {
  const lines = readFileSync(join(logsDir, file), "utf8").split("\n");
  let current = null;
  for (const line of lines) {
    const start = /^=== create (\S+) arm (\S+) start ===$/.exec(line);
    const boot = /^=== boot /.exec(line);
    if (start) {
      current = key(start[1], start[2]);
      records[current] ??= {
        id: start[1], arm: start[2], log: file,
        pipeline: [], lanes: [], smokeSkips: 0, buildFailed: false, refusalIssues: [],
      };
      continue;
    }
    if (boot) { current = null; continue; }
    if (!current) continue;
    const rec = records[current];
    if (line.includes("[vendo] gen pipeline ")) rec.pipeline.push(line.trim());
    else if (/\[vendo\] gen (paint|full|outline|section|repair|end-pass) (first-partial|complete)/.test(line)) rec.lanes.push(line.trim());
    else if (line.includes("smoke-render gate skipped")) rec.smokeSkips += 1;
    else if (line.includes("app build failed")) rec.buildFailed = true;
    else if (rec.buildFailed && /^\s+- /.test(line)) rec.refusalIssues.push(line.trim());
  }
}

console.log(JSON.stringify(records, null, 2));
