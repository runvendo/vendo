import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS, PRODUCTION_MODEL } from "./runner/models";

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

  it("stamps the model into the request and the JSON summary", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "genui-bench-cli-"));
    const result = runCli([
      "run", "--host", "maple", "--prompt", "hi", "--runs-dir", runsDir,
      "--model", "Opus 5", "--thinking", "high",
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    const summary = JSON.parse(lines[lines.length - 1]);
    expect(summary.runs[0].model).toEqual({ id: "claude-opus-5", effort: "high" });

    const pathLine = lines.find((line) => line.endsWith("run.json"))!.trim();
    const record = JSON.parse(readFileSync(pathLine, "utf8"));
    expect(record.request.model).toEqual({ id: "claude-opus-5", effort: "high" });
  }, 30_000);

  it("names the engine default in the summary when no model is chosen", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "genui-bench-cli-"));
    const result = runCli(["run", "--host", "maple", "--prompt", "hi", "--runs-dir", runsDir]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    const summary = JSON.parse(lines[lines.length - 1]);
    expect(summary.runs[0].model).toEqual({ id: PRODUCTION_MODEL.id });

    const pathLine = lines.find((line) => line.endsWith("run.json"))!.trim();
    // Absent on the request: an untouched run measures what ships.
    expect(JSON.parse(readFileSync(pathLine, "utf8")).request.model).toBeUndefined();
  }, 30_000);

  it("rejects an unknown model, listing the valid ids", () => {
    const result = runCli(["run", "--host", "maple", "--prompt", "hi", "--model", "gpt-9"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown --model "gpt-9"');
    for (const model of MODELS) expect(result.stderr).toContain(model.id);
  }, 30_000);

  it("rejects settings the chosen model does not accept", () => {
    const hot = runCli([
      "run", "--host", "maple", "--prompt", "hi", "--model", "claude-opus-5", "--temperature", "0.7",
    ]);
    expect(hot.status).toBe(1);
    expect(hot.stderr).toContain("does not accept a temperature");

    const budgeted = runCli([
      "run", "--host", "maple", "--prompt", "hi", "--model", "claude-opus-5", "--thinking", "4096",
    ]);
    expect(budgeted.status).toBe(1);
    expect(budgeted.stderr).toContain("no thinking token budget");

    const effortless = runCli([
      "run", "--host", "maple", "--prompt", "hi", "--model", "Haiku 4.5", "--thinking", "high",
    ]);
    expect(effortless.status).toBe(1);
    expect(effortless.stderr).toContain("no effort parameter");
  }, 45_000);

  it("rejects sampling flags without an explicit --model", () => {
    const result = runCli(["run", "--host", "maple", "--prompt", "hi", "--temperature", "0.5"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("need an explicit --model");
  }, 30_000);
});
