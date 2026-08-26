import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = join(packageDir, "scripts/build-mcp-app-shim.mjs");
const committed = resolve(packageDir, "../mcp/src/shim/shim-html.gen.ts");

// A dynamic-execution primitive used as an executor call: `new Function(...)`, a
// bare global `Function(...)` (indirect eval), or `eval(...)`. Anchored to the
// call form and gated on a non-identifier, non-`.` prefix so it never matches the
// minified bundle's own identifiers that merely end in "Function(" — the embedded
// interpreter ships dozens (callFunction(, parseFunction(, QTS_NewFunction(, …).
const EXECUTOR = /(^|[^.\w$])(new\s+Function|Function|eval)\s*\(/;
// The refusal the shim renders instead of executing generated component source.
const REFUSAL_MARKER = "no longer runs in the host page";

// The committed MCP shim bundle (packages/mcp/src/shim/shim-html.gen.ts) is
// generated from src/tree/mcp-shim/entry.tsx by build:mcp-shim, wired into no
// build step. It once shipped stale for a whole release cycle, carrying a
// `new Function` executor for generated component source that the source had
// already refused.
//
// The load-bearing guard is executor-absence: the shipped bundle — and a fresh
// rebuild — must contain no dynamic-execution primitive and must keep the refusal
// marker. That assertion runs on the bytes directly, so it fails CI if the source
// re-adds `new Function` even when the committed file still matches a fresh build.
//
// The byte-compare below is a secondary staleness nudge, not the security line.
// It is kept byte-exact for simplicity: a cosmetic Vite/esbuild/Rollup output
// change trips it, and the fix is to regenerate on a toolchain bump
// (`pnpm --filter @vendoai/ui build:mcp-shim`) and commit. That is a maintenance
// chore, not a vulnerability — executor-absence is proven independently above.
describe("MCP shim bundle", () => {
  let tmp: string;
  let fresh: string;
  let current: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vendo-mcp-shim-"));
    const out = join(tmp, "shim-html.gen.ts");
    await execFileAsync(process.execPath, [generator], {
      env: { ...process.env, VENDO_MCP_SHIM_OUT: out },
    });
    [fresh, current] = await Promise.all([
      readFile(out, "utf8"),
      readFile(committed, "utf8"),
    ]);
  }, 120_000);

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const expectNoExecutor = (bundle: string, label: string) => {
    expect(
      EXECUTOR.test(bundle),
      `${label} shim bundle contains a dynamic-execution primitive (new Function / Function( / eval() — it must never execute generated component source in the host page`,
    ).toBe(false);
    expect(
      bundle.includes(REFUSAL_MARKER),
      `${label} shim bundle is missing the refusal marker ${JSON.stringify(REFUSAL_MARKER)}`,
    ).toBe(true);
  };

  it("committed bundle contains no dynamic-execution primitive", () => {
    expectNoExecutor(current, "committed");
  });

  it("freshly-built bundle contains no dynamic-execution primitive", () => {
    expectNoExecutor(fresh, "freshly-built");
  });

  it("committed bundle matches a fresh regeneration", () => {
    expect(
      fresh === current,
      "packages/mcp/src/shim/shim-html.gen.ts is out of date — run `pnpm --filter @vendoai/ui build:mcp-shim` and commit the result",
    ).toBe(true);
  });
});
