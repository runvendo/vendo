import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = __dirname;
const TSX = join(APP_DIR, "node_modules", ".bin", "tsx");

function runCli(args: string[]) {
  return spawnSync(TSX, ["cli.ts", ...args], {
    cwd: APP_DIR,
    encoding: "utf8",
    // Stub adapters: the CLI must never call a model in tests.
    env: { ...process.env, GENUI_BENCH_FAKE_LANES: "1" },
  });
}

describe("cli", () => {
  it("runs one prompt headlessly: exit 0, RunRecord path, JSON summary line", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "genui-bench-cli-"));
    const result = runCli(["run", "--host", "maple", "--prompt", "hi", "--lanes", "vendo", "--runs-dir", runsDir]);

    expect(result.status).toBe(0);

    const lines = result.stdout.trim().split("\n");
    const pathLine = lines.find((line) => line.includes(runsDir) && line.endsWith("run.json"));
    expect(pathLine).toBeDefined();
    expect(existsSync(pathLine!.trim())).toBe(true);

    const summary = JSON.parse(lines[lines.length - 1]);
    expect(summary.runs).toHaveLength(1);
    expect(summary.runs[0].prompt).toBe("hi");
    expect(summary.runs[0].vendo.status).toBe("ok");
    expect(typeof summary.runs[0].vendo.durationMs).toBe("number");
    expect(summary.runs[0].vendo.repairs).toBe(0);
  }, 30_000);

  it("runs every prompt in a pack", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "genui-bench-cli-"));
    const result = runCli(["run", "--host", "maple", "--pack", "smoke", "--runs-dir", runsDir]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    const summary = JSON.parse(lines[lines.length - 1]);
    expect(summary.runs).toHaveLength(3);
    expect(summary.runs[0].prompt).toBe("show my account balances at a glance");
  }, 30_000);

  it("fails loudly on usage errors", () => {
    const result = runCli(["run", "--prompt", "hi"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--host");
  }, 30_000);
});
