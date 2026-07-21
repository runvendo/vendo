import type { ExecFileException } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createLineSplitter,
  ENGINE_PACKAGE_NAME,
  ENGINE_PACKAGE_VERSION,
  npxEngineHarness,
  resolveNpmExecResult,
} from "./npx-engine-harness.js";

describe("npxEngineHarness", () => {
  describe("availability", () => {
    it("is unavailable with no credential at all", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({ root: "/x", env: {} })).toBeNull();
    });

    it("labels ANTHROPIC_API_KEY, naming the download", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" } }))
        .toBe("your ANTHROPIC_API_KEY (via the Vendo engine, ~250MB one-time download)");
    });

    it("falls back to VENDO_API_KEY, naming the Vendo Cloud key and the download", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({ root: "/x", env: { VENDO_API_KEY: "vnd_x" } }))
        .toBe("your Vendo Cloud key (managed inference, via the Vendo engine, ~250MB one-time download)");
    });

    it("prefers ANTHROPIC_API_KEY's label over the Vendo Cloud key when both are set", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({
        root: "/x",
        env: { ANTHROPIC_API_KEY: "sk", VENDO_API_KEY: "vnd_x" },
      })).toBe("your ANTHROPIC_API_KEY (via the Vendo engine, ~250MB one-time download)");
    });

    it("treats a blank ANTHROPIC_API_KEY as absent and falls back to VENDO_API_KEY", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({ root: "/x", env: { ANTHROPIC_API_KEY: "   ", VENDO_API_KEY: "vnd_x" } }))
        .toBe("your Vendo Cloud key (managed inference, via the Vendo engine, ~250MB one-time download)");
    });

    // Spec-review follow-up (b216d0f4 landed hasOwnAnthropicEnvOverride after
    // this rung shipped): ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN /
    // ANTHROPIC_BASE_URL are each an own credential too — composeGatewayFuel
    // refuses to overlay onto any of them, so labeling the rung "your Vendo
    // Cloud key" for a dev who has one of these would misdescribe what run()
    // actually does with their env.
    it("labels ANTHROPIC_AUTH_TOKEN as an own credential, naming the download", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({ root: "/x", env: { ANTHROPIC_AUTH_TOKEN: "corp-tok" } }))
        .toBe("your ANTHROPIC_AUTH_TOKEN (via the Vendo engine, ~250MB one-time download)");
    });

    it("labels CLAUDE_CODE_OAUTH_TOKEN as an own credential, naming the download", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({ root: "/x", env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" } }))
        .toBe("your CLAUDE_CODE_OAUTH_TOKEN (via the Vendo engine, ~250MB one-time download)");
    });

    it("labels ANTHROPIC_BASE_URL as an own credential, naming the download", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({ root: "/x", env: { ANTHROPIC_BASE_URL: "https://corp.example/v1" } }))
        .toBe("your ANTHROPIC_BASE_URL (via the Vendo engine, ~250MB one-time download)");
    });

    it("prefers the own-credential env-override label over the Vendo Cloud key when both are set", async () => {
      const harness = npxEngineHarness();
      expect(await harness.availability({
        root: "/x",
        env: { ANTHROPIC_AUTH_TOKEN: "corp-tok", ANTHROPIC_BASE_URL: "https://corp.example/v1", VENDO_API_KEY: "vnd_x" },
      })).toBe("your ANTHROPIC_AUTH_TOKEN (via the Vendo engine, ~250MB one-time download)");
    });

    it("never invokes the exec seam (no npm/network probe)", async () => {
      let execCalls = 0;
      const harness = npxEngineHarness({ exec: async () => { execCalls += 1; return { stdout: "", stderr: "", code: 0 }; } });
      await harness.availability({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" } });
      await harness.availability({ root: "/x", env: {} });
      expect(execCalls).toBe(0);
    });
  });

  describe("run", () => {
    it("invokes `npm exec --yes @vendoai/engine@<PINNED_VERSION> -- run` with cwd = host root", async () => {
      let capturedArgs: string[] = [];
      let capturedOptions: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
      const harness = npxEngineHarness({
        exec: async (args, options) => {
          capturedArgs = args;
          capturedOptions = options;
          return { stdout: "the result", stderr: "", code: 0 };
        },
      });
      const text = await harness.run({ root: "/host/root", env: {}, instructions: "go read the codebase" });
      expect(text).toBe("the result");
      expect(capturedArgs).toEqual(["exec", "--yes", `${ENGINE_PACKAGE_NAME}@${ENGINE_PACKAGE_VERSION}`, "--", "run"]);
      expect(capturedOptions?.cwd).toBe("/host/root");
    });

    it("pins an exact version, never a range", () => {
      expect(ENGINE_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      expect(ENGINE_PACKAGE_NAME).toBe("@vendoai/engine");
    });

    it("writes the job JSON ({ instructions, root }) to the child's stdin — no credentials inside it", async () => {
      let capturedInput = "";
      const harness = npxEngineHarness({
        exec: async (_args, options) => { capturedInput = options.input; return { stdout: "ok", stderr: "", code: 0 }; },
      });
      await harness.run({
        root: "/host/root",
        env: { ANTHROPIC_API_KEY: "sk-should-not-appear-in-job" },
        instructions: "go read the codebase",
      });
      expect(JSON.parse(capturedInput)).toEqual({ instructions: "go read the codebase", root: "/host/root" });
      expect(capturedInput).not.toContain("sk-should-not-appear-in-job");
    });

    it("passes cwd = host root and forwards the caller's env over process.env", async () => {
      let capturedOptions: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
      const harness = npxEngineHarness({
        exec: async (_args, options) => { capturedOptions = options; return { stdout: "ok", stderr: "", code: 0 }; },
      });
      process.env["VENDO_NPX_ENGINE_TEST_MARKER"] = "from-process-env";
      try {
        await harness.run({
          root: "/host/root",
          env: { CALLER_ONLY: "yes", VENDO_NPX_ENGINE_TEST_MARKER: "from-caller", ANTHROPIC_API_KEY: "sk" },
          instructions: "go",
        });
      } finally {
        delete process.env["VENDO_NPX_ENGINE_TEST_MARKER"];
      }
      expect(capturedOptions?.cwd).toBe("/host/root");
      expect(capturedOptions?.env["CALLER_ONLY"]).toBe("yes");
      expect(capturedOptions?.env["VENDO_NPX_ENGINE_TEST_MARKER"]).toBe("from-caller");
    });

    it("emits a first-run download notice via onProgress before invoking exec", async () => {
      const order: string[] = [];
      const harness = npxEngineHarness({
        exec: async () => { order.push("exec-called"); return { stdout: "ok", stderr: "", code: 0 }; },
      });
      await harness.run({
        root: "/x",
        env: { ANTHROPIC_API_KEY: "sk" },
        instructions: "go",
        onProgress: (line) => order.push(`progress:${line}`),
      });
      expect(order[0]).toMatch(/^progress:/);
      expect(order[0]).toMatch(/250MB/);
      expect(order[0]).toMatch(/cach/i);
      expect(order.indexOf("exec-called")).toBeGreaterThan(order.indexOf(order[0]));
      expect(order.indexOf("exec-called")).toBe(1);
    });

    it("forwards child stderr lines to onProgress via onStderrLine", async () => {
      const progressLines: string[] = [];
      const harness = npxEngineHarness({
        exec: async (_args, options) => {
          options.onStderrLine?.("resolving dependencies…");
          options.onStderrLine?.("running extraction…");
          return { stdout: "ok", stderr: "", code: 0 };
        },
      });
      await harness.run({
        root: "/x",
        env: { ANTHROPIC_API_KEY: "sk" },
        instructions: "go",
        onProgress: (line) => progressLines.push(line),
      });
      expect(progressLines).toContain("resolving dependencies…");
      expect(progressLines).toContain("running extraction…");
    });

    it("returns stdout verbatim on success", async () => {
      const harness = npxEngineHarness({
        exec: async () => ({ stdout: '{"brief":"b","tools":[]}', stderr: "", code: 0 }),
      });
      expect(await harness.run({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" }, instructions: "go" }))
        .toBe('{"brief":"b","tools":[]}');
    });

    it("throws including stderr context on nonzero exit", async () => {
      const harness = npxEngineHarness({
        exec: async () => ({ stdout: "", stderr: "auth failed: token expired", code: 1 }),
      });
      await expect(harness.run({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" }, instructions: "go" }))
        .rejects.toThrow(/auth failed: token expired/);
    });

    it("surfaces an offline/registry-unreachable failure with npm's own descriptive stderr", async () => {
      const harness = npxEngineHarness({
        exec: async () => ({ stdout: "", stderr: "npm error code ENOTFOUND registry.npmjs.org", code: 1 }),
      });
      await expect(harness.run({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" }, instructions: "go" }))
        .rejects.toThrow(/ENOTFOUND/);
    });

    describe("Vendo Cloud gateway fuel", () => {
      it("does not overlay the env when ANTHROPIC_API_KEY is present (own credential wins)", async () => {
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const harness = npxEngineHarness({
          exec: async (_args, options) => { capturedEnv = options.env; return { stdout: "ok", stderr: "", code: 0 }; },
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

      it("overlays the gateway env, tagged with the init-purpose header, when only VENDO_API_KEY is set", async () => {
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const harness = npxEngineHarness({
          exec: async (_args, options) => { capturedEnv = options.env; return { stdout: "ok", stderr: "", code: 0 }; },
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

      it("does not overlay the env when neither credential is set (unreachable via availability(), belt-and-suspenders)", async () => {
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const harness = npxEngineHarness({
          exec: async (_args, options) => { capturedEnv = options.env; return { stdout: "ok", stderr: "", code: 0 }; },
        });
        await harness.run({ root: "/x", env: {}, instructions: "go" });
        expect(capturedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
      });

      // Spec-review follow-up: the corporate-gateway pair (own auth token +
      // own base URL) plus a VENDO_API_KEY alongside it must pass through to
      // the child completely untouched — composeGatewayFuel must not clobber
      // a dev's already-configured BYO endpoint just because VENDO_API_KEY is
      // also present, matching the label availability() now gives this case.
      it("passes ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL through untouched even with VENDO_API_KEY set (no CUSTOM_HEADERS)", async () => {
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const harness = npxEngineHarness({
          exec: async (_args, options) => { capturedEnv = options.env; return { stdout: "ok", stderr: "", code: 0 }; },
        });
        await harness.run({
          root: "/x",
          env: {
            ANTHROPIC_AUTH_TOKEN: "corp-tok",
            ANTHROPIC_BASE_URL: "https://corp.example/v1",
            VENDO_API_KEY: "vnd_x",
          },
          instructions: "go",
        });
        expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("corp-tok");
        expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("https://corp.example/v1");
        expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      });
    });
  });

  describe("resolveNpmExecResult", () => {
    it("maps a successful exit (no error) straight through", () => {
      expect(resolveNpmExecResult(null, "out", "err")).toEqual({ stdout: "out", stderr: "err", code: 0 });
    });

    it("maps a normal nonzero process exit through its numeric code", () => {
      const error = Object.assign(new Error("Command failed"), { code: 1 }) as ExecFileException;
      expect(resolveNpmExecResult(error, "", "npm error code ENOTFOUND")).toEqual({
        stdout: "",
        stderr: "npm error code ENOTFOUND",
        code: 1,
      });
    });

    it("produces a clear, actionable message when npm itself cannot be launched (ENOENT)", () => {
      const error = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }) as ExecFileException;
      const result = resolveNpmExecResult(error, "", "");
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/npm could not be launched/);
      expect(result.stderr).toMatch(/is npm installed and on PATH\?/);
      expect(result.stderr).toContain("spawn npm ENOENT");
    });

    // Code-review follow-up: EACCES (npm present but not executable — a
    // permissions problem, not a missing install) is "similar spawn-level
    // string code" to ENOENT and must route the same way, not fall through
    // to the timeout/generic branches.
    it("treats EACCES the same as ENOENT — a real spawn-layer failure", () => {
      const error = Object.assign(new Error("spawn npm EACCES"), { code: "EACCES" }) as ExecFileException;
      const result = resolveNpmExecResult(error, "", "");
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/npm could not be launched/);
      expect(result.stderr).toContain("spawn npm EACCES");
    });

    // Code-review follow-up: previously this fell into the SAME "npm could
    // not be launched" branch as ENOENT (error.code is null here, which also
    // fails `typeof error.code === "number"`), falsely telling a dev whose
    // 15-minute extraction just timed out that npm isn't installed.
    it("gives a killed/timeout its own honest message naming the timeout duration — never the npm-not-installed message", () => {
      const error = Object.assign(new Error("Command failed"), {
        killed: true,
        signal: "SIGTERM",
        code: null,
      }) as unknown as ExecFileException;
      const result = resolveNpmExecResult(error, "", "");
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/15-minute timeout/);
      expect(result.stderr).toContain("SIGTERM");
      expect(result.stderr).not.toMatch(/npm could not be launched/);
      expect(result.stderr).not.toMatch(/is npm installed/);
    });

    it("checks killed before the spawn-failure branch even if a stray string code is also present", () => {
      const error = Object.assign(new Error("Command failed"), {
        killed: true,
        signal: "SIGTERM",
        code: "SOMETHING",
      }) as unknown as ExecFileException;
      const result = resolveNpmExecResult(error, "", "");
      expect(result.stderr).toMatch(/timeout/);
      expect(result.stderr).not.toMatch(/npm could not be launched/);
    });

    it("forwards npm's own stderr without fabricating a diagnosis for any other non-numeric, non-killed shape", () => {
      const error = Object.assign(new Error("weird"), {}) as ExecFileException;
      const result = resolveNpmExecResult(error, "", "npm warn deprecated foo@1.0.0");
      expect(result).toEqual({ stdout: "", stderr: "npm warn deprecated foo@1.0.0", code: 1 });
    });
  });

  describe("createLineSplitter", () => {
    it("emits each line from a single multi-line chunk", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push("first\nsecond\nthird\n");
      expect(lines).toEqual(["first", "second", "third"]);
    });

    it("reassembles a line split across two chunks", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push("resolving depend");
      splitter.push("encies…\n");
      expect(lines).toEqual(["resolving dependencies…"]);
    });

    it("flushes a trailing line with no final newline instead of dropping it", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push("complete line\nno trailing newline");
      expect(lines).toEqual(["complete line"]);
      splitter.flush();
      expect(lines).toEqual(["complete line", "no trailing newline"]);
    });

    it("flush is a no-op when there is no pending partial line", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push("one\n");
      splitter.flush();
      expect(lines).toEqual(["one"]);
    });

    it("skips blank lines, matching the child protocol's narration framing", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push("a\n\nb\n");
      expect(lines).toEqual(["a", "b"]);
    });
  });
});
