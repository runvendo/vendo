import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseInstallEvalArgs, runCli } from "../cli.js";
import { createRunContext } from "../run-context.js";
import type { RunInstallAgentOptions } from "./agent.js";
import { INSTALL_EVAL_DEFAULTS, runInstallEvalCommand, type InstallEvalCommandOptions } from "./run.js";
import { writeInstallEvalReport } from "./report.js";
import type { InstallEvalReportDocument } from "./report.js";

describe("parseInstallEvalArgs", () => {
  it("applies documented defaults", () => {
    expect(parseInstallEvalArgs([])).toEqual({
      fixtureNames: [],
      model: INSTALL_EVAL_DEFAULTS.model,
      dryRun: false,
      json: false,
      strict: false,
      turnBudget: INSTALL_EVAL_DEFAULTS.turnBudget,
      timeBudgetMs: INSTALL_EVAL_DEFAULTS.timeBudgetMs,
      maxBudgetUsd: INSTALL_EVAL_DEFAULTS.maxBudgetUsd,
    });
  });

  it("parses fixtures, budgets, and flags", () => {
    const options = parseInstallEvalArgs([
      "express-host", "--model", "haiku", "--dry-run", "--json", "--strict",
      "--turn-budget=25", "--time-budget-ms", "60000", "--max-budget-usd", "2.5",
    ]);
    expect(options.fixtureNames).toEqual(["express-host"]);
    expect(options.model).toBe("haiku");
    expect(options.dryRun).toBe(true);
    expect(options.json).toBe(true);
    expect(options.strict).toBe(true);
    expect(options.turnBudget).toBe(25);
    expect(options.timeBudgetMs).toBe(60_000);
    expect(options.maxBudgetUsd).toBe(2.5);
  });

  it("rejects unknown options", () => {
    expect(() => parseInstallEvalArgs(["--layer", "1"])).toThrow(/Unknown install-eval option/);
  });
});

function dryRunOptions(overrides: Partial<InstallEvalCommandOptions> = {}): InstallEvalCommandOptions {
  return {
    fixtureNames: ["express-host"],
    model: "sonnet",
    dryRun: true,
    json: false,
    strict: false,
    turnBudget: 40,
    timeBudgetMs: 60_000,
    maxBudgetUsd: 5,
    ...overrides,
  };
}

describe("runInstallEvalCommand --dry-run", () => {
  it("runs the whole pipeline off the canned transcript without invoking the agent or doctor", async () => {
    const corpusRoot = await mkdtemp(path.join(tmpdir(), "install-eval-run-"));
    const context = createRunContext({ corpusRoot });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let agentInvoked = false;
    let doctorInvoked = false;
    let preparedRegistryUrl = "";

    const exit = await runInstallEvalCommand(dryRunOptions(), {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      now: () => new Date("2026-07-19T12:00:00.000Z"),
      env: {},
      workspaceRoot: corpusRoot,
      context,
      readPrompt: async () => "Install Vendo in this repo.",
      packTarballs: async (options) => options.cacheDir,
      startRegistry: async () => ({ url: "http://127.0.0.1:9999", close: async () => {} }),
      prepare: async (options) => {
        preparedRegistryUrl = options.registryUrl;
        return path.join(corpusRoot, "fixture-copy");
      },
      runAgent: async () => {
        agentInvoked = true;
        throw new Error("dry-run must never invoke the agent");
      },
      runDoctor: async () => {
        doctorInvoked = true;
        throw new Error("dry-run must never run doctor");
      },
      readToolState: async () => ({ toolNames: [], referencedToolNames: [] }),
      writeReport: writeInstallEvalReport,
    });

    expect(exit).toBe(0);
    expect(agentInvoked).toBe(false);
    expect(doctorInvoked).toBe(false);
    expect(preparedRegistryUrl).toBe("http://127.0.0.1:9999");

    const reportsDir = path.join(corpusRoot, "reports");
    const reports = await readdir(reportsDir);
    expect(reports.some((file) => file.startsWith("install-eval-") && file.endsWith(".md"))).toBe(true);
    expect(reports.some((file) => file.endsWith(".json"))).toBe(true);
    const markdownFile = reports.find((file) => file.endsWith(".md"))!;
    const markdown = await readFile(path.join(reportsDir, markdownFile), "utf8");
    expect(markdown).toContain("Mode: dry-run");
    // The canned agent asks mid-run but never STOPS on the question, so the
    // ask gate never blocked it.
    expect(markdown).toContain("| express-host | yes | 7/40 | yes | not-reached | none |");
    expect(stdout.join("\n")).toContain("Report:");
  });

  it("--strict fails when a fixture is not clean", async () => {
    const corpusRoot = await mkdtemp(path.join(tmpdir(), "install-eval-strict-"));
    const context = createRunContext({ corpusRoot });
    const exit = await runInstallEvalCommand(dryRunOptions({ strict: true }), {
      stdout: () => {},
      stderr: () => {},
      now: () => new Date("2026-07-19T12:00:00.000Z"),
      env: {},
      workspaceRoot: corpusRoot,
      context,
      readPrompt: async () => "Install Vendo in this repo.",
      packTarballs: async (options) => options.cacheDir,
      startRegistry: async () => ({ url: "http://127.0.0.1:9999", close: async () => {} }),
      prepare: async () => {
        throw new Error("fixture prep exploded");
      },
      readToolState: async () => ({ toolNames: [], referencedToolNames: [] }),
      writeReport: writeInstallEvalReport,
    });
    expect(exit).toBe(1);
  });
});

/** What the transcript file looks like after the scripted-human seam replied
 * once: the first `claude -p` invocation ends on the mandated key question,
 * and the `--resume` continuation (appended to the same file) runs through
 * doctor to the star ask. One init + one result event per invocation. */
const TWO_TURN_TRANSCRIPT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Cloud vs. bring-your-own for the model key — which do you want? I won't touch keys or accounts until you answer." }] } }),
  JSON.stringify({ type: "result", subtype: "success", num_turns: 3, total_cost_usd: 0.4, duration_ms: 60_000, result: "Cloud vs. bring-your-own for the model key — which do you want? I won't touch keys or accounts until you answer." }),
  JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npx vendo init --yes --auth none --byo" } }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "npx vendo doctor --json" } }] } }),
  JSON.stringify({ type: "result", subtype: "success", num_turns: 9, total_cost_usd: 1.1, duration_ms: 240_000, result: "Doctor is green. Want me to star runvendo/vendo on GitHub to support the project?" }),
  "",
].join("\n");

describe("runInstallEvalCommand with the scripted two-turn agent seam", () => {
  it("scores turns, cost, and the ask gate across BOTH invocations of one run", async () => {
    const corpusRoot = await mkdtemp(path.join(tmpdir(), "install-eval-two-turn-"));
    const context = createRunContext({ corpusRoot });
    const stdout: string[] = [];
    let agentOptions: RunInstallAgentOptions | undefined;

    const exit = await runInstallEvalCommand(dryRunOptions({ dryRun: false, json: true }), {
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      now: () => new Date("2026-07-21T12:00:00.000Z"),
      env: {},
      workspaceRoot: corpusRoot,
      context,
      readPrompt: async () => "Install Vendo in this repo.",
      packTarballs: async (options) => options.cacheDir,
      startRegistry: async () => ({ url: "http://127.0.0.1:9999", close: async () => {} }),
      prepare: async () => path.join(corpusRoot, "fixture-copy"),
      runAgent: async (options) => {
        agentOptions = options;
        // Stand-in for runInstallAgent: turn 1 ended on the key question, the
        // scripted human answered once, turn 2 appended to the transcript.
        await mkdir(path.dirname(options.transcriptPath), { recursive: true });
        await writeFile(options.transcriptPath, TWO_TURN_TRANSCRIPT);
        return { code: 0, timedOut: false, command: "fake-claude", scriptedReplies: 1 };
      },
      runDoctor: async () => ({ ran: true, green: true, failingCodes: [] }),
      readToolState: async () => ({ toolNames: [], referencedToolNames: [] }),
      writeReport: writeInstallEvalReport,
    });

    expect(exit).toBe(0);
    expect(agentOptions?.prompt).toBe("Install Vendo in this repo.");
    const report = JSON.parse(stdout.join("\n")) as InstallEvalReportDocument;
    const fixture = report.fixtures[0]!;
    expect(fixture.askGate).toBe("reached-and-answered");
    // Budgets cover the whole run: both invocations' turns and cost sum.
    expect(fixture.turns).toBe(12);
    expect(fixture.costUsd).toBeCloseTo(1.5);
    expect(fixture.durationMs).toBe(300_000);
    expect(fixture.askedBeforeAccount.pass).toBe(true);
    expect(fixture.violations).toHaveLength(0);
  });
});

describe("cli dispatch", () => {
  it("routes install-eval through the injectable runner", async () => {
    let received: InstallEvalCommandOptions | undefined;
    const exit = await runCli(["install-eval", "express-host", "--dry-run"], {
      stdout: () => {},
      stderr: () => {},
      runInstallEval: async (options) => {
        received = options;
        return 0;
      },
    });
    expect(exit).toBe(0);
    expect(received?.fixtureNames).toEqual(["express-host"]);
    expect(received?.dryRun).toBe(true);
  });
});
