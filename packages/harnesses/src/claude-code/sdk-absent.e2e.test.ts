/**
 * D1 — the consumer who has NOT installed the ~250MB Agent SDK.
 *
 * The measured failure this pins: `@vendoai/apps/internal` re-exported the SDK
 * turn, the render seam imports `./internal` statically on every composed host's
 * server path, and a bundler that folds `import(CONST)` therefore demanded
 * `@anthropic-ai/claude-agent-sdk` at BUILD time from a Next.js host that had no
 * reason to install it. `harness: claudeCode()` could not be committed to a real
 * host at all.
 *
 * Proven in a SUBPROCESS whose module resolver genuinely cannot find the SDK —
 * an in-workspace test would pass on a hoisted copy and prove nothing. A loader
 * hook refuses that one specifier and nothing else, which is exactly what a
 * consumer's node_modules looks like.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (path: string): string => pathToFileURL(join(PACKAGE_DIR, path)).href;
const appsDist = (path: string): string =>
  pathToFileURL(join(PACKAGE_DIR, "..", "apps", path)).href;

const work = mkdtempSync(join(tmpdir(), "vendo-sdk-absent-"));
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

/** Refuses exactly one specifier, the way a machine that never installed it does. */
writeFileSync(join(work, "hide-sdk.mjs"), `
export async function resolve(specifier, context, next) {
  if (specifier === "@anthropic-ai/claude-agent-sdk") {
    const error = new Error("Cannot find package '@anthropic-ai/claude-agent-sdk'");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return next(specifier, context);
}
`);
writeFileSync(join(work, "register.mjs"), `
import { register } from "node:module";
register("./hide-sdk.mjs", import.meta.url);
`);

const runProbe = (body: string): string => {
  const script = join(work, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, body);
  return execFileSync(process.execPath, ["--import", join(work, "register.mjs"), script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

describe("D1 · a host that never installed the Agent SDK", () => {
  test("the loader hook really does hide it — otherwise every case below is vacuous", () => {
    const output = runProbe(`
      try {
        await import("@anthropic-ai/claude-agent-sdk");
        console.log("RESOLVED");
      } catch (error) {
        console.log("HIDDEN", error.code);
      }
    `);
    expect(output).toContain("HIDDEN ERR_MODULE_NOT_FOUND");
  });

  test("@vendoai/apps, its cross-block internals, and the turn runner itself all import", () => {
    const output = runProbe(`
      const apps = await import(${JSON.stringify(appsDist("dist/index.js"))});
      const internal = await import(${JSON.stringify(appsDist("dist/internal.js"))});
      const runner = await import(${JSON.stringify(appsDist("dist/claude-turn.js"))});
      if (typeof apps.createApps !== "function") throw new Error("apps did not load");
      if (typeof internal.assembleTree !== "function") throw new Error("internals did not load");
      if (typeof runner.createClaudeSession !== "function") throw new Error("runner did not load");
      console.log("APPS_OK");
    `);
    expect(output).toContain("APPS_OK");
  });

  test("claudeCode() composes with a sandbox and passes the boot gate", () => {
    const output = runProbe(`
      const { claudeCode } = await import(${JSON.stringify(dist("dist/claude-code/index.js"))});
      const { assertHarnessComposable } = await import(${JSON.stringify(dist("dist/index.js"))});
      const sandbox = { async create() {}, async destroy() {} };
      // The sandbox path: the SDK lives in the box image, never here.
      assertHarnessComposable(claudeCode(), { sandbox });
      assertHarnessComposable(claudeCode({ sandbox }), { sandbox });
      // And the opt-in still CONSTRUCTS — it only fails when it is asked to run.
      claudeCode({ machine: "local" });
      console.log("COMPOSE_OK");
    `);
    expect(output).toContain("COMPOSE_OK");
  });

  test("only machine:\"local\" fails, and it NAMES the package to install", () => {
    const output = runProbe(`
      const { localMachine } = await import(${JSON.stringify(dist("dist/claude-code/local.js"))});
      const machine = await localMachine({ threadId: "thr_sdk_absent", env: {} });
      try {
        await machine.send({ prompt: "go", tools: [], callTool: async () => ({ status: "ok", output: {} }), emit: () => {} });
        console.log("NO_ERROR");
      } catch (error) {
        console.log("MESSAGE:" + error.message);
      }
    `);
    expect(output).toContain("@anthropic-ai/claude-agent-sdk");
    // Names the way OUT as well as the way in: a sandbox keeps it off the server.
    expect(output).toContain("give the harness a sandbox instead");
    expect(output).not.toContain("NO_ERROR");
  });
});
