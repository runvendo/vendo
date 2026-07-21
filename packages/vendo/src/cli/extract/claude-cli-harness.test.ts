import { describe, expect, it } from "vitest";
import { claudeCliHarness } from "./claude-cli-harness.js";

describe("claudeCliHarness", () => {
  it("is unavailable without the claude binary on PATH, regardless of credentials", async () => {
    const harness = claudeCliHarness({ probeBinary: async () => false, probeLogin: async () => true });
    expect(await harness.availability({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" } })).toBeNull();
  });

  it("prefers the env key label, then the Claude Code login", async () => {
    const withBinary = { probeBinary: async () => true };
    expect(await claudeCliHarness({ ...withBinary, probeLogin: async () => false })
      .availability({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" } })).toBe("your ANTHROPIC_API_KEY");
    expect(await claudeCliHarness({ ...withBinary, probeLogin: async () => true })
      .availability({ root: "/x", env: {} })).toBe("your Claude Code login");
    expect(await claudeCliHarness({ ...withBinary, probeLogin: async () => false })
      .availability({ root: "/x", env: {} })).toBeNull();
  });

  it("invokes claude headless with print mode, the exact tool allowlist/denylist, and isolated settings", async () => {
    let capturedArgs: string[] = [];
    const harness = claudeCliHarness({
      exec: async (args) => {
        capturedArgs = args;
        return { stdout: "the result", stderr: "", code: 0 };
      },
    });
    const text = await harness.run({ root: "/host/root", env: {}, instructions: "go read the codebase" });
    expect(text).toBe("the result");
    expect(capturedArgs).toEqual([
      "-p", "go read the codebase",
      "--allowedTools", "Read", "Glob", "Grep",
      "--disallowedTools",
      "Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit", "KillShell", "BashOutput",
      "--setting-sources", "",
    ]);
  });

  it("passes cwd = host root and forwards the caller's env over process.env", async () => {
    let capturedOptions: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
    const harness = claudeCliHarness({
      exec: async (_args, options) => {
        capturedOptions = options;
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });
    process.env["VENDO_CLI_HARNESS_TEST_MARKER"] = "from-process-env";
    try {
      await harness.run({
        root: "/host/root",
        env: { CALLER_ONLY: "yes", VENDO_CLI_HARNESS_TEST_MARKER: "from-caller" },
        instructions: "go",
      });
    } finally {
      delete process.env["VENDO_CLI_HARNESS_TEST_MARKER"];
    }
    expect(capturedOptions?.cwd).toBe("/host/root");
    expect(capturedOptions?.env["CALLER_ONLY"]).toBe("yes");
    // caller env wins over process.env for a key present in both.
    expect(capturedOptions?.env["VENDO_CLI_HARNESS_TEST_MARKER"]).toBe("from-caller");
  });

  it("passes VENDO_EXTRACTION_MODEL as --model when set, and omits --model/--permission-mode otherwise", async () => {
    let capturedArgs: string[] = [];
    const harness = claudeCliHarness({
      exec: async (args) => {
        capturedArgs = args;
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });
    await harness.run({ root: "/x", env: {}, instructions: "go" });
    expect(capturedArgs).not.toContain("--model");
    expect(capturedArgs).not.toContain("--permission-mode");

    await harness.run({ root: "/x", env: { VENDO_EXTRACTION_MODEL: "claude-fable-5" }, instructions: "go" });
    expect(capturedArgs.slice(-2)).toEqual(["--model", "claude-fable-5"]);
  });

  it("returns stdout on success", async () => {
    const harness = claudeCliHarness({
      exec: async () => ({ stdout: '{"brief":"b","tools":[]}', stderr: "", code: 0 }),
    });
    expect(await harness.run({ root: "/x", env: {}, instructions: "go" })).toBe('{"brief":"b","tools":[]}');
  });

  it("throws including stderr context on nonzero exit", async () => {
    const harness = claudeCliHarness({
      exec: async () => ({ stdout: "", stderr: "auth failed: token expired", code: 1 }),
    });
    await expect(harness.run({ root: "/x", env: {}, instructions: "go" }))
      .rejects.toThrow(/auth failed: token expired/);
  });
});
