import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

// NOTE: the jsdom test environment (this package's vitest config) replaces
// the global `URL` with jsdom's polyfill, which `node:url`'s fileURLToPath
// rejects ("must be of scheme file"). Stick to plain path joins here instead
// of `new URL(..., import.meta.url)`.
const packageRoot = process.cwd();
const binPath = join(packageRoot, "bin", "vendo.mjs");
const pkgVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

/**
 * Child env for spawning the stub: a fake-npx dir prepended to PATH, and
 * NODE_PATH stripped — pnpm-run vitest sets NODE_PATH to pnpm's hoisted
 * store (which contains the real @vendoai/cli), but real host installs
 * have no NODE_PATH, and these tests simulate a host.
 */
function childEnv(pathDir) {
  const env = { ...process.env, PATH: `${pathDir}${delimiter}${process.env.PATH}` };
  delete env.NODE_PATH;
  return env;
}

/** Writes an executable fake `npx` into `dir` that marks itself as hit. */
function writeNpxStub(dir) {
  const npxStub = join(dir, "npx");
  writeFileSync(
    npxStub,
    "#!/usr/bin/env node\nconsole.log('NPX-HIT ' + process.argv.slice(2).join(' '));\nprocess.exit(7);\n",
  );
  chmodSync(npxStub, 0o755);
  return dir;
}

describe("bin/vendo.mjs", () => {
  it("falls back to `npx -y @vendoai/cli@<version>` when no local CLI is installed (repo layout has none)", () => {
    const pathDir = writeNpxStub(mkdtempSync(join(tmpdir(), "vendo-bin-test-")));

    const result = spawnSync(process.execPath, [binPath, "--help", "init"], {
      env: childEnv(pathDir),
      encoding: "utf8",
    });

    expect(result.stdout.trim()).toBe(`NPX-HIT -y @vendoai/cli@${pkgVersion} --help init`);
    expect(result.status).toBe(7);
  });

  it("prefers a host-installed @vendoai/cli (runs it directly, never touching npx)", () => {
    // Fake host app: node_modules/@vendoai/cli with a bin, plus the vendo
    // package (this stub + its package.json) installed alongside it. Node
    // resolution from the stub walks up into the host's node_modules.
    const host = mkdtempSync(join(tmpdir(), "vendo-bin-local-test-"));
    const cliDir = join(host, "node_modules", "@vendoai", "cli");
    mkdirSync(join(cliDir, "dist"), { recursive: true });
    writeFileSync(
      join(cliDir, "package.json"),
      JSON.stringify({ name: "@vendoai/cli", version: "9.9.9", bin: { vendo: "./dist/cli.js" } }),
    );
    writeFileSync(
      join(cliDir, "dist", "cli.js"),
      "console.log('LOCAL-CLI ' + process.argv.slice(2).join(' '));\nprocess.exit(3);\n",
    );
    const vendoDir = join(host, "node_modules", "vendo");
    mkdirSync(join(vendoDir, "bin"), { recursive: true });
    copyFileSync(join(packageRoot, "package.json"), join(vendoDir, "package.json"));
    copyFileSync(binPath, join(vendoDir, "bin", "vendo.mjs"));

    // A fake npx is still on PATH so we can prove it is NOT used.
    const pathDir = writeNpxStub(mkdtempSync(join(tmpdir(), "vendo-bin-test-")));

    const result = spawnSync(process.execPath, [join(vendoDir, "bin", "vendo.mjs"), "sync"], {
      env: childEnv(pathDir),
      encoding: "utf8",
    });

    expect(result.stdout.trim()).toBe("LOCAL-CLI sync");
    expect(result.stdout).not.toContain("NPX-HIT");
    expect(result.status).toBe(3);
  });
});
