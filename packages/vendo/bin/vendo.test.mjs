import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

// NOTE: the jsdom test environment (this package's vitest config) replaces
// the global `URL` with jsdom's polyfill, which `node:url`'s fileURLToPath
// rejects ("must be of scheme file"). Stick to plain path joins here instead
// of `new URL(..., import.meta.url)`.
const packageRoot = process.cwd();
const binPath = join(packageRoot, "bin", "vendo.mjs");
const pkgVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

describe("bin/vendo.mjs", () => {
  it("delegates to `npx -y @vendoai/cli@<version>`, forwarding argv and exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "vendo-bin-test-"));
    const npxStub = join(dir, "npx");
    writeFileSync(
      npxStub,
      "#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join(' '));\nprocess.exit(7);\n",
    );
    chmodSync(npxStub, 0o755);

    const result = spawnSync(process.execPath, [binPath, "--help", "init"], {
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });

    expect(result.stdout.trim()).toBe(`-y @vendoai/cli@${pkgVersion} --help init`);
    expect(result.status).toBe(7);
  });
});
