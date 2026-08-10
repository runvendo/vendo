/**
 * D1, the APPS half — a consumer who has NOT installed the ~250MB Agent SDK
 * can still import this package.
 *
 * The measured failure this pins: an apps entry re-exported the SDK
 * turn, the render seam imports `./internal` statically on every composed
 * host's server path, and a bundler that folds `import(CONST)` therefore
 * demanded `@anthropic-ai/claude-agent-sdk` at BUILD time from a Next.js host
 * that had no reason to install it. The turn runner has since moved to
 * `@vendoai/harnesses` (claude-code/claude-turn.ts), which carries its own
 * half of this pin (`tests/claude-code/sdk-absent.e2e.test.ts`) — the halves
 * are split per package because each probes its OWN dist, and only a
 * package's own test task is guaranteed to run after its build.
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

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (path: string): string => pathToFileURL(join(PACKAGE_DIR, path)).href;

const work = mkdtempSync(join(tmpdir(), "vendo-apps-sdk-absent-"));
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
  test("the loader hook really does hide it — otherwise the case below is vacuous", () => {
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

  test("@vendoai/apps and its cross-block internals both import", () => {
    const output = runProbe(`
      const apps = await import(${JSON.stringify(dist("dist/server/index.js"))});
      if (typeof apps.createApps !== "function") throw new Error("apps did not load");
      if (typeof apps.assembleTree !== "function") throw new Error("internals did not load");
      console.log("APPS_OK");
    `);
    expect(output).toContain("APPS_OK");
  });
});
