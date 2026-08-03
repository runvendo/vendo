/**
 * `pnpm --filter genui-bench measure --arm baseline` — turn one sweep's
 * RunRecords into the committed measurement artifact (JSON rows + summary) and
 * a human-readable .md. `--compare <arm>` adds the before/after table.
 *
 * Reads only; the sweep itself is measure/sweep.sh.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { listRuns, loadRun } from "../runner/store";
import type { HostName } from "../runner/types";
import { measureRecord, summarize, type AppMeasurement, type Summary } from "./metrics";
import { renderMarkdown } from "./report";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function writeTools(): Promise<Partial<Record<HostName, ReadonlySet<string>>>> {
  const { fixtures } = await import("../fixtures");
  const entries = Object.entries(fixtures).map(([host, fixture]) => {
    const tools = (fixture?.tools ?? []) as Array<{ name: string; risk?: string }>;
    return [host, new Set(tools.filter((tool) => tool.risk !== "read").map((tool) => tool.name))] as const;
  });
  return Object.fromEntries(entries);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arm: { type: "string" },
      "runs-dir": { type: "string" },
      out: { type: "string" },
      compare: { type: "string" },
      date: { type: "string" },
    },
  });
  const arm = values.arm ?? "baseline";
  const runsDir = values["runs-dir"] ?? join(APP_DIR, "runs", "_measure", arm);
  if (!existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir} — run measure/sweep.sh ${arm} first`);

  const risk = await writeTools();
  const rows: AppMeasurement[] = listRuns(runsDir)
    .map((slim) => measureRecord(loadRun(runsDir, slim.id), risk))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const summary = summarize(arm, rows);

  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const out = values.out ?? join(APP_DIR, "measurements", `${date}-island-escape-${arm}.json`);
  mkdirSync(dirname(out), { recursive: true });

  let previous: { summary: Summary; rows: AppMeasurement[] } | undefined;
  if (values.compare !== undefined) {
    const path = existsSync(values.compare)
      ? values.compare
      : join(APP_DIR, "measurements", `${date}-island-escape-${values.compare}.json`);
    previous = JSON.parse(await import("node:fs").then(({ readFileSync }) => readFileSync(path, "utf8"))) as typeof previous;
  }

  writeFileSync(out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  const mdPath = out.replace(/\.json$/, ".md");
  writeFileSync(mdPath, renderMarkdown({ summary, rows }, previous));
  console.log(out);
  console.log(mdPath);
  console.log(JSON.stringify(summary));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
