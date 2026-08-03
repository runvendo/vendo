import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { RunRecord } from "../../../runner/types";

/** The /api/run subprocess: spawn it exactly like the route does and prove
 *  (a) missing lane modules degrade to a failed lane — never a crash — and
 *  (b) a resolvable lane module runs and persists. Stub modules only; no
 *  model calls, no keys. */

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(appDir, "app", "api", "run", "exec-run.ts");
const tsxBin = join(appDir, "node_modules", ".bin", "tsx");

let workDir: string;
let runsDir: string;
let lanesDir: string;
let fixturesModule: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "genui-bench-exec-"));
  runsDir = join(workDir, "runs");
  lanesDir = join(workDir, "lanes");
  mkdirSync(lanesDir, { recursive: true });

  fixturesModule = join(workDir, "fixtures.ts");
  writeFileSync(
    fixturesModule,
    `export const fixtures = {
      maple: { name: "maple", catalog: {}, tools: [], shapes: {}, theme: {}, execute: async () => ({}) },
    };\n`,
  );
  // Only the vendo stub exists — tambo stays a missing module.
  writeFileSync(
    join(lanesDir, "vendo.ts"),
    `const adapter = {
      name: "vendo",
      generate: async () => ({ status: "ok", startedAt: Date.now(), durationMs: 5, findings: [] }),
    };
    export default adapter;\n`,
  );
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function runScript(lanes: string[]): RunRecord {
  const request = { prompt: "hi", host: "maple", lanes };
  const stdout = execFileSync(tsxBin, [script, JSON.stringify(request), runsDir], {
    cwd: appDir,
    encoding: "utf8",
    env: { ...process.env, GENUI_BENCH_FIXTURES_MODULE: fixturesModule, GENUI_BENCH_LANES_DIR: lanesDir },
  });
  const { id } = JSON.parse(stdout.trim().split("\n").pop()!) as { id: string };
  return JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8")) as RunRecord;
}

test(
  "resolvable lane runs; missing lane module degrades to a failed lane",
  { timeout: 30_000 }, // tsx cold start dominates (same budget as cli.test.ts)
  () => {
    const record = runScript(["vendo", "tambo"]);
    expect(record.lanes.vendo?.status).toBe("ok");
    expect(record.lanes.tambo?.status).toBe("failed");
    expect(record.lanes.tambo).toMatchObject({ error: expect.stringContaining("no adapter") });
  },
);
