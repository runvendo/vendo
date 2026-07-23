import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCliHarness } from "./claude-cli-harness.js";

// The harness now judges credentials against {...process.env, ...input.env}
// (the env the child actually spawns with), so ambient credentials on the
// machine running the suite must be cleared for these controlled-env
// expectations to hold anywhere.
const AMBIENT_CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "VENDO_API_KEY",
  "VENDO_CLOUD_URL",
] as const;

describe("claudeCliHarness", () => {
  beforeEach(() => {
    for (const name of AMBIENT_CREDENTIAL_VARS) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

    // VENDO_MODEL_EXTRACT (models spec 2026-07-22) outranks the deprecated var.
    await harness.run({
      root: "/x",
      env: { VENDO_MODEL_EXTRACT: "vendo-extract", VENDO_EXTRACTION_MODEL: "claude-fable-5" },
      instructions: "go",
    });
    expect(capturedArgs.slice(-2)).toEqual(["--model", "vendo-extract"]);
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

  it("relays a gateway refusal message verbatim, without truncation", async () => {
    const refusal =
      "init-inference-blocked: Vendo Cloud gateway inference is not available on the free plan during "
      + "`vendo init`. Bring your own Claude Code login or ANTHROPIC_API_KEY, or upgrade your org's plan.";
    const harness = claudeCliHarness({
      exec: async () => ({ stdout: "", stderr: refusal, code: 1 }),
    });
    await expect(harness.run({ root: "/x", env: {}, instructions: "go" }))
      .rejects.toThrow(new RegExp(refusal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  describe("Vendo Cloud gateway fuel", () => {
    it("does not label or fuel the rung on VENDO_API_KEY alone when the binary is absent", async () => {
      const harness = claudeCliHarness({ probeBinary: async () => false, probeLogin: async () => false });
      expect(await harness.availability({ root: "/x", env: { VENDO_API_KEY: "vnd_x" } })).toBeNull();
    });

    it("labels the rung with the Vendo Cloud key when no own credential is available", async () => {
      const harness = claudeCliHarness({
        probeBinary: async () => true,
        probeLogin: async () => false,
      });
      expect(await harness.availability({ root: "/x", env: { VENDO_API_KEY: "vnd_x" } }))
        .toBe("your Vendo Cloud key (managed inference)");
    });

    it("prefers ANTHROPIC_API_KEY's label over the Vendo Cloud key when both are set", async () => {
      const harness = claudeCliHarness({
        probeBinary: async () => true,
        probeLogin: async () => false,
      });
      expect(await harness.availability({
        root: "/x",
        env: { ANTHROPIC_API_KEY: "sk", VENDO_API_KEY: "vnd_x" },
      })).toBe("your ANTHROPIC_API_KEY");
    });

    it("prefers the Claude Code login label over the Vendo Cloud key when both are usable", async () => {
      const harness = claudeCliHarness({
        probeBinary: async () => true,
        probeLogin: async () => true,
      });
      expect(await harness.availability({ root: "/x", env: { VENDO_API_KEY: "vnd_x" } }))
        .toBe("your Claude Code login");
    });

    it("labels the rung with ANTHROPIC_AUTH_TOKEN, not the Vendo Cloud key, when both are set (corporate gateway)", async () => {
      const harness = claudeCliHarness({ probeBinary: async () => true, probeLogin: async () => false });
      expect(await harness.availability({
        root: "/x",
        env: { ANTHROPIC_AUTH_TOKEN: "corp-token", VENDO_API_KEY: "vnd_x" },
      })).toBe("your ANTHROPIC_AUTH_TOKEN");
    });

    it("labels the rung with ANTHROPIC_AUTH_TOKEN even with a custom ANTHROPIC_BASE_URL set alongside it", async () => {
      const harness = claudeCliHarness({ probeBinary: async () => true, probeLogin: async () => false });
      expect(await harness.availability({
        root: "/x",
        env: {
          ANTHROPIC_AUTH_TOKEN: "corp-token",
          ANTHROPIC_BASE_URL: "https://anthropic.corp.example.com",
          VENDO_API_KEY: "vnd_x",
        },
      })).toBe("your ANTHROPIC_AUTH_TOKEN");
    });

    it("labels the rung with CLAUDE_CODE_OAUTH_TOKEN, not the Vendo Cloud key, when both are set", async () => {
      const harness = claudeCliHarness({ probeBinary: async () => true, probeLogin: async () => false });
      expect(await harness.availability({
        root: "/x",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", VENDO_API_KEY: "vnd_x" },
      })).toBe("your CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("labels the rung with ANTHROPIC_BASE_URL when only a custom base URL is set (no token), not the Vendo Cloud key", async () => {
      const harness = claudeCliHarness({ probeBinary: async () => true, probeLogin: async () => false });
      expect(await harness.availability({
        root: "/x",
        env: { ANTHROPIC_BASE_URL: "https://anthropic.corp.example.com", VENDO_API_KEY: "vnd_x" },
      })).toBe("your ANTHROPIC_BASE_URL");
    });

    it("does not overlay the env when ANTHROPIC_API_KEY is present (own credential wins)", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const harness = claudeCliHarness({
        probeLogin: async () => false,
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({
        root: "/x",
        env: { ANTHROPIC_API_KEY: "sk", VENDO_API_KEY: "vnd_x" },
        instructions: "go",
      });
      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    });

    it("does not overlay the env when the Claude Code login is satisfied (own credential wins)", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const harness = claudeCliHarness({
        probeLogin: async () => true,
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({ root: "/x", env: { VENDO_API_KEY: "vnd_x" }, instructions: "go" });
      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    });

    it("does not probe the Claude Code login (no side effect) when VENDO_API_KEY is unset", async () => {
      let probeCalls = 0;
      const harness = claudeCliHarness({
        probeLogin: async () => {
          probeCalls += 1;
          return false;
        },
        exec: async () => ({ stdout: "ok", stderr: "", code: 0 }),
      });
      await harness.run({ root: "/x", env: {}, instructions: "go" });
      expect(probeCalls).toBe(0);
    });

    it("does not overlay when ANTHROPIC_AUTH_TOKEN is set (corporate gateway), and skips the login probe", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      let probeCalls = 0;
      const harness = claudeCliHarness({
        probeLogin: async () => {
          probeCalls += 1;
          return false;
        },
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({
        root: "/x",
        env: { ANTHROPIC_AUTH_TOKEN: "corp-token", VENDO_API_KEY: "vnd_x" },
        instructions: "go",
      });
      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      // the caller's own ANTHROPIC_AUTH_TOKEN must survive untouched
      expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("corp-token");
      expect(probeCalls).toBe(0);
    });

    it("does not overlay when ANTHROPIC_AUTH_TOKEN is paired with a custom ANTHROPIC_BASE_URL (corporate gateway)", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const harness = claudeCliHarness({
        probeLogin: async () => false,
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({
        root: "/x",
        env: {
          ANTHROPIC_AUTH_TOKEN: "corp-token",
          ANTHROPIC_BASE_URL: "https://anthropic.corp.example.com",
          VENDO_API_KEY: "vnd_x",
        },
        instructions: "go",
      });
      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("https://anthropic.corp.example.com");
      expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("corp-token");
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    });

    it("does not overlay when CLAUDE_CODE_OAUTH_TOKEN is set, and skips the login probe", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      let probeCalls = 0;
      const harness = claudeCliHarness({
        probeLogin: async () => {
          probeCalls += 1;
          return false;
        },
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({
        root: "/x",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", VENDO_API_KEY: "vnd_x" },
        instructions: "go",
      });
      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      expect(capturedEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
      expect(probeCalls).toBe(0);
    });

    it("does not overlay when only ANTHROPIC_BASE_URL is set (no token), and skips the login probe", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      let probeCalls = 0;
      const harness = claudeCliHarness({
        probeLogin: async () => {
          probeCalls += 1;
          return false;
        },
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({
        root: "/x",
        env: { ANTHROPIC_BASE_URL: "https://anthropic.corp.example.com", VENDO_API_KEY: "vnd_x" },
        instructions: "go",
      });
      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("https://anthropic.corp.example.com");
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      expect(probeCalls).toBe(0);
    });

    // AI-review fix: the guard must see the child's REAL env. The child
    // spawns with {...process.env, ...input.env, ...overlay}, so an ambient
    // (process.env) BYO credential with a partial input.env carrying only
    // VENDO_API_KEY previously slipped past the input.env-only guard and got
    // its endpoint clobbered by the gateway overlay.
    it("does not overlay when ANTHROPIC_AUTH_TOKEN is ambient in process.env and input.env carries only VENDO_API_KEY", async () => {
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-corp-token");
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      let probeCalls = 0;
      const harness = claudeCliHarness({
        probeLogin: async () => {
          probeCalls += 1;
          return false;
        },
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({ root: "/x", env: { VENDO_API_KEY: "vnd_x" }, instructions: "go" });
      // The ambient token survives untouched — the overlay must not clobber it.
      expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("ambient-corp-token");
      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      // Env-based own credential short-circuits the login probe, same as
      // when the token rides input.env.
      expect(probeCalls).toBe(0);
    });

    it("labels the rung with the ambient ANTHROPIC_AUTH_TOKEN, not the Vendo Cloud key (labels agree with run())", async () => {
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-corp-token");
      const harness = claudeCliHarness({ probeBinary: async () => true, probeLogin: async () => false });
      expect(await harness.availability({ root: "/x", env: { VENDO_API_KEY: "vnd_x" } }))
        .toBe("your ANTHROPIC_AUTH_TOKEN");
    });

    it("lets input.env win over an ambient credential for the guard, matching child-env precedence", async () => {
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-corp-token");
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const harness = claudeCliHarness({
        probeLogin: async () => false,
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({
        root: "/x",
        env: { ANTHROPIC_AUTH_TOKEN: "caller-token", VENDO_API_KEY: "vnd_x" },
        instructions: "go",
      });
      expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("caller-token");
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    });

    it("overlays the gateway env, tagged with the init-purpose header, when unauthenticated and VENDO_API_KEY is set", async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const harness = claudeCliHarness({
        probeLogin: async () => false,
        exec: async (_args, options) => {
          capturedEnv = options.env;
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({
        root: "/x",
        env: { VENDO_API_KEY: "vnd_x", VENDO_CLOUD_URL: "http://localhost:3001/" },
        instructions: "go",
      });
      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("http://localhost:3001/api/v1");
      expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("vnd_x");
      expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBe("x-vendo-purpose: init");
    });
  });
});
