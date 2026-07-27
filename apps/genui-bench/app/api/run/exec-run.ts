/**
 * Subprocess entry for POST /api/run — spawned via tsx so lane/fixture
 * modules resolve OUTSIDE the Next bundler. That buys two things:
 * (a) the CLI's lazy-import pattern works here, so a lane module that hasn't
 *     landed yet degrades to a failed lane instead of a build/route crash;
 * (b) every run re-imports the live working tree — the spec's "a Cursor edit
 *     is live on the next run", with no bundler cache in the loop.
 *
 * argv: [requestJson, runsDir] · stdout (last line): {"id":"<run id>"}
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { executeRun } from "../../../runner/run";
import type { HostFixture, HostName, LaneAdapter, RunRequest } from "../../../runner/types";

async function main(): Promise<void> {
  const [requestJson, runsDir] = process.argv.slice(2);
  if (!requestJson || !runsDir) throw new Error("usage: exec-run.ts <requestJson> <runsDir>");
  const request = JSON.parse(requestJson) as RunRequest;
  loadRootEnv();

  // Variable specifiers keep tsc from resolving modules that other lanes are
  // still landing (cli.ts pattern). The GENUI_BENCH_* env overrides are test
  // seams: they point at stub modules so tests never call models.
  let fixtures: Partial<Record<HostName, HostFixture>> = {};
  try {
    const fixturesSpecifier = process.env.GENUI_BENCH_FIXTURES_MODULE ?? "../../../fixtures";
    fixtures = ((await import(fixturesSpecifier)) as { fixtures: typeof fixtures }).fixtures;
  } catch {
    // No fixtures module yet → executeRun marks every lane failed.
  }

  const lanesBase = process.env.GENUI_BENCH_LANES_DIR ?? "../../../lanes";
  const adapters: LaneAdapter[] = [];
  for (const lane of request.lanes) {
    try {
      const laneSpecifier = `${lanesBase}/${lane}`;
      const mod = (await import(laneSpecifier)) as { default?: LaneAdapter; adapter?: LaneAdapter };
      const adapter = mod.default ?? mod.adapter;
      if (adapter) adapters.push(adapter);
    } catch {
      // Missing lane module → executeRun marks the lane failed
      // ("no adapter registered"), the run still completes.
    }
  }

  const record = await executeRun(request, fixtures, adapters, runsDir);
  console.log(JSON.stringify({ id: record.id }));
}

/** Source-only root .env load (duplicated from cli.ts, which runs its main on
 *  import): fills unset process.env keys, never prints values. */
function loadRootEnv(): void {
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
