import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = join(packageDir, "scripts/build-mcp-app-shim.mjs");
const committed = resolve(packageDir, "../mcp/src/shim/shim-html.gen.ts");

// The committed MCP shim bundle (packages/mcp/src/shim/shim-html.gen.ts) is
// generated from src/tree/mcp-shim/entry.tsx by build:mcp-shim, which is wired
// into no build step. It once shipped stale for a whole release cycle, carrying
// a `new Function` executor for generated component source that the source had
// already refused. This is the drift guard: regenerate to a temp file and prove
// the committed bytes still match the current source. On failure, run
// `pnpm --filter @vendoai/ui build:mcp-shim` and commit the result.
describe("MCP shim bundle", () => {
  let tmp: string;

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("committed bundle matches a fresh regeneration", async () => {
    tmp = await mkdtemp(join(tmpdir(), "vendo-mcp-shim-"));
    const out = join(tmp, "shim-html.gen.ts");
    await execFileAsync(process.execPath, [generator], {
      env: { ...process.env, VENDO_MCP_SHIM_OUT: out },
    });
    const [fresh, current] = await Promise.all([
      readFile(out, "utf8"),
      readFile(committed, "utf8"),
    ]);
    expect(
      fresh === current,
      "packages/mcp/src/shim/shim-html.gen.ts is out of date — run `pnpm --filter @vendoai/ui build:mcp-shim` and commit the result",
    ).toBe(true);
  }, 120_000);
});
