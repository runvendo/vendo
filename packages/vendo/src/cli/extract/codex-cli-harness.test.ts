import { describe, expect, it } from "vitest";
import { codexCliHarness, insertOutputLastMessageFlag, resolveCodexExecResult } from "./codex-cli-harness.js";

describe("codexCliHarness", () => {
  it("is unavailable without the codex binary on PATH, regardless of credentials", async () => {
    const harness = codexCliHarness({ probeBinary: async () => false, probeLogin: async () => true });
    expect(await harness.availability({ root: "/x", env: { OPENAI_API_KEY: "sk" } })).toBeNull();
  });

  it("prefers the env key label, then the ChatGPT login", async () => {
    const withBinary = { probeBinary: async () => true };
    expect(await codexCliHarness({ ...withBinary, probeLogin: async () => false })
      .availability({ root: "/x", env: { OPENAI_API_KEY: "sk" } })).toBe("your OPENAI_API_KEY");
    expect(await codexCliHarness({ ...withBinary, probeLogin: async () => true })
      .availability({ root: "/x", env: {} })).toBe("your ChatGPT login");
    expect(await codexCliHarness({ ...withBinary, probeLogin: async () => false })
      .availability({ root: "/x", env: {} })).toBeNull();
  });

  it("falls through to null when codex is present but unauthenticated (no env key, no login)", async () => {
    const harness = codexCliHarness({ probeBinary: async () => true, probeLogin: async () => false });
    expect(await harness.availability({ root: "/x", env: {} })).toBeNull();
  });

  it("invokes codex headless with exec mode, read-only sandbox, and isolated config", async () => {
    let capturedArgs: string[] = [];
    const harness = codexCliHarness({
      exec: async (args) => {
        capturedArgs = args;
        return { stdout: "the result", stderr: "", code: 0 };
      },
    });
    const text = await harness.run({ root: "/host/root", env: {}, instructions: "go read the codebase" });
    expect(text).toBe("the result");
    expect(capturedArgs).toEqual([
      "exec",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-C", "/host/root",
      "go read the codebase",
    ]);
  });

  it("passes cwd = host root and forwards the caller's env over process.env", async () => {
    let capturedOptions: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
    const harness = codexCliHarness({
      exec: async (_args, options) => {
        capturedOptions = options;
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });
    process.env["VENDO_CODEX_HARNESS_TEST_MARKER"] = "from-process-env";
    try {
      await harness.run({
        root: "/host/root",
        env: { CALLER_ONLY: "yes", VENDO_CODEX_HARNESS_TEST_MARKER: "from-caller" },
        instructions: "go",
      });
    } finally {
      delete process.env["VENDO_CODEX_HARNESS_TEST_MARKER"];
    }
    expect(capturedOptions?.cwd).toBe("/host/root");
    expect(capturedOptions?.env["CALLER_ONLY"]).toBe("yes");
    // caller env wins over process.env for a key present in both.
    expect(capturedOptions?.env["VENDO_CODEX_HARNESS_TEST_MARKER"]).toBe("from-caller");
  });

  it("passes VENDO_EXTRACTION_MODEL as --model when set, and omits it otherwise", async () => {
    let capturedArgs: string[] = [];
    const harness = codexCliHarness({
      exec: async (args) => {
        capturedArgs = args;
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });
    await harness.run({ root: "/x", env: {}, instructions: "go" });
    expect(capturedArgs).not.toContain("--model");

    await harness.run({ root: "/x", env: { VENDO_EXTRACTION_MODEL: "gpt-5-codex" }, instructions: "go" });
    expect(capturedArgs.slice(-3)).toEqual(["--model", "gpt-5-codex", "go"]);

    // VENDO_MODEL_EXTRACT (models spec 2026-07-22) outranks the deprecated var.
    await harness.run({
      root: "/x",
      env: { VENDO_MODEL_EXTRACT: "gpt-5", VENDO_EXTRACTION_MODEL: "gpt-5-codex" },
      instructions: "go",
    });
    expect(capturedArgs.slice(-3)).toEqual(["--model", "gpt-5", "go"]);
  });

  it("returns the final message text on success", async () => {
    const harness = codexCliHarness({
      exec: async () => ({ stdout: '{"brief":"b","tools":[]}', stderr: "", code: 0 }),
    });
    expect(await harness.run({ root: "/x", env: {}, instructions: "go" })).toBe('{"brief":"b","tools":[]}');
  });

  it("throws including stderr context on nonzero exit", async () => {
    const harness = codexCliHarness({
      exec: async () => ({ stdout: "", stderr: "auth failed: token expired", code: 1 }),
    });
    await expect(harness.run({ root: "/x", env: {}, instructions: "go" }))
      .rejects.toThrow(/auth failed: token expired/);
  });

  it("throws a clear error when the exec seam reports failure without stderr", async () => {
    const harness = codexCliHarness({
      exec: async () => ({ stdout: "", stderr: "", code: 1 }),
    });
    await expect(harness.run({ root: "/x", env: {}, instructions: "go" }))
      .rejects.toThrow(/codex exited with code 1/);
  });
});

describe("insertOutputLastMessageFlag", () => {
  it("inserts --output-last-message before the trailing free-text instructions positional, not after it", () => {
    const args = ["exec", "--sandbox", "read-only", "-C", "/root", "go read the codebase --with a dash"];
    expect(insertOutputLastMessageFlag(args, "/tmp/out.txt")).toEqual([
      "exec", "--sandbox", "read-only", "-C", "/root",
      "--output-last-message", "/tmp/out.txt",
      "go read the codebase --with a dash",
    ]);
  });
});

describe("resolveCodexExecResult", () => {
  it("passes the raw process result through unchanged on nonzero exit", () => {
    expect(resolveCodexExecResult(1, "narration", "boom", undefined)).toEqual({
      stdout: "narration",
      stderr: "boom",
      code: 1,
    });
  });

  it("returns the final message as stdout on a clean exit with a readable output file", () => {
    expect(resolveCodexExecResult(0, "narration", "", '{"brief":"b","tools":[]}')).toEqual({
      stdout: '{"brief":"b","tools":[]}',
      stderr: "",
      code: 0,
    });
  });

  it("synthesizes a code-1 failure when codex exits 0 but the output-last-message file is missing", () => {
    expect(resolveCodexExecResult(0, "narration", "", undefined)).toEqual({
      stdout: "",
      stderr: "codex produced no final message (--output-last-message file missing)",
      code: 1,
    });
  });
});
