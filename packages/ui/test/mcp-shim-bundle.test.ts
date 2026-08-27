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
// That same prefix gate is why this is a targeted tripwire for the known forms,
// not an exhaustive scan — see the block comment below for what it does and
// doesn't prove.
const EXECUTOR = /(^|[^.\w$])(new\s+Function|Function|eval)\s*\(/;
// The refusal the shim renders instead of executing generated component source.
const REFUSAL_MARKER = "no longer runs in the host page";

// The committed MCP shim bundle (packages/mcp/src/shim/shim-html.gen.ts) is
// generated from src/tree/mcp-shim/entry.tsx by build:mcp-shim, wired into no
// build step. It once shipped stale for a whole release cycle, carrying a
// `new Function` executor for generated component source that the source had
// already refused.
//
// The executor-absence checks below are a targeted regression tripwire for the
// specific forms that removed executor used (`new Function`, bare `Function(`,
// `eval(`) — not an adversarial proof that the bundle contains no dynamic
// execution of any kind. They do not catch a deliberately obfuscated or indirect
// executor (`globalThis.Function(`, `obj.Function(`, `["Function"](...)`,
// `.constructor("...")(...)`). Broadening the scan to catch those forms is
// intentionally avoided: it would false-positive against the bundled QuickJS
// interpreter's own identifiers (see EXECUTOR's prefix gate above).
//
// What's actually load-bearing is that the bundle byte-matches a fresh build of
// the current source, and the current source (renderer.tsx) refuses to execute
// `source:"generated"` component code. A dynamic executor can only reappear in
// the bundle if one is reintroduced in source — which the source-level refusal
// and its review are what prevent. The tripwire above is belt-and-suspenders on
// top of that for the common forms, not the security boundary itself.
//
// The byte-compare below is kept byte-exact for simplicity: a cosmetic
// Vite/esbuild/Rollup output change trips it, and the fix is to regenerate on a
// toolchain bump (`pnpm --filter @vendoai/ui build:mcp-shim`) and commit. That is
// a maintenance chore, not a vulnerability.
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
      `${label} shim bundle matches a known dynamic-execution call form (new Function / Function( / eval() — the signature the removed native executor used`,
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
