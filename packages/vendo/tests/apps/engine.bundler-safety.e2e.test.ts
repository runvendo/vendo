/**
 * The TSX toolchain (checking/toolchain.ts) lazy-loads
 * esbuild (a native-binary package). A bundler (webpack, or Next's Turbopack) that
 * sees a literal `import("esbuild")` in a module it's bundling walks INTO
 * esbuild's own package to build its module graph — regardless of whether
 * the import ever executes — and esbuild's lib/main.js resolves its native
 * binary with its own dynamic require, which a bundler cannot statically
 * follow. The bundler then tries to parse the platform binary and its
 * README.md as JS modules and hard-fails the build ("Unknown module type",
 * "invalid utf-8 sequence"). Every Next host importing
 * "@vendoai/vendo/server" reaches this file transitively through
 * @vendoai/vendo/apps, so this broke EVERY host build, masked only by the demo
 * apps' own `next.config` carrying `serverExternalPackages: ["esbuild"]`.
 *
 * Fix: `webpackIgnore`/`turbopackIgnore` magic comments on the import() call
 * tell the bundler to skip resolving this specific specifier entirely,
 * instead of walking into esbuild's package. Node ignores magic comments —
 * this stays a plain dynamic import at runtime, so it still works under
 * Vitest's vm-sandboxed test runner (a `new Function`-built indirection was
 * tried first and rejected: it hides the specifier from the bundler too, but
 * throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING under Vitest, breaking the
 * existing engine tests).
 *
 * This test inspects the package's real dist output directly — proving what a
 * consumer actually imports, not just the source a human edits.
 *
 * It READS that output rather than building it. It used to shell out to
 * `tsc -p tsconfig.json`, which was cheap while this file lived in
 * `@vendoai/apps`; S11d moved it into `@vendoai/vendo`, where the same command
 * compiles a package roughly ten times the size — twice, once per case —
 * synchronously inside a vitest worker. That starves vitest's own reporter IPC
 * and the shard exits 1 with every test passing
 * (`[vitest-worker]: Timeout calling "onTaskUpdate"`, monorepo.yml:321).
 * Building here was always redundant: turbo.json's `test` task declares
 * `dependsOn: ["^build", "build"]`, so dist is on disk before this file runs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** A NAKED literal dynamic import for "esbuild" — nothing between `import(`
 *  and the string — is exactly the shape a bundler resolves at build time. */
const NAKED_ESBUILD_IMPORT = /import\(\s*["']esbuild["']\s*\)/;

/** The magic-comment-guarded form: both webpack's and Turbopack's ignore
 *  directives immediately precede the specifier, inside the `import(...)`
 *  call. Both are asserted (not just one) because real hosts build with
 *  either bundler depending on their Next.js mode/version. */
/** 2026-07 Workers field failure: the LITERAL guarded form was still
 *  hard-resolved by esbuild-the-bundler (Wrangler ignores webpack-dialect
 *  comments), inlining esbuild-the-package into Worker bundles where its
 *  __filename reference crashed the island validator and failed every app
 *  build. The guard is now a MUTABLE SPECIFIER (invisible to every bundler,
 *  still a plain dynamic import under Node/Vitest) with the magic comments
 *  kept so webpack/turbopack emit no critical-dependency warning. */
const GUARDED_ESBUILD_IMPORT =
  /import\(\s*\/\*\s*webpackIgnore:\s*true\s*\*\/\s*\/\*\s*turbopackIgnore:\s*true\s*\*\/\s*(?:\/\*\s*@vite-ignore\s*\*\/\s*)?ESBUILD_SPECIFIER\s*\)/;

function distToolchainSource(): string {
  const built = join(PACKAGE_DIR, "dist", "apps", "checking", "toolchain.js");
  // Absent means the build did not run, not that the guard holds — say so,
  // rather than reading an empty string past both assertions.
  if (!existsSync(built)) throw new Error(`${built} is missing — run \`pnpm build\` first`);
  return readFileSync(built, "utf8");
}

describe("toolchain.ts esbuild import — bundler-style reachability (built dist)", () => {
  it("the compiled dist never carries a naked, bundler-resolvable esbuild specifier", () => {
    const compiled = distToolchainSource();
    expect(NAKED_ESBUILD_IMPORT.test(compiled)).toBe(false);
  });

  it("the compiled dist keeps the webpackIgnore + turbopackIgnore guarded form (tsc preserves comments; this is the actual proof, not just source)", () => {
    const compiled = distToolchainSource();
    expect(GUARDED_ESBUILD_IMPORT.test(compiled)).toBe(true);
  });
});

/**
 * The other half of bundler-safety, and the one a green suite missed for a
 * release: not "does a bundler leave the specifier alone" but "does the
 * specifier still RESOLVE once a bundler has moved this module".
 *
 * A bare "esbuild" resolves relative to the module that CONTAINS the import.
 * While `@vendoai/vendo` was in `serverExternalPackages` that module always sat
 * in the package's own directory, so it always worked. Once the umbrella had to
 * leave that list — it has a "use client" half, and the list is
 * package-granular — its code was copied into `.next/server/chunks/…`, whose
 * nearest node_modules is the APP ROOT: npm flat-hoists esbuild there and pnpm
 * does not, so screen checking died on every pnpm host while npm stayed green.
 *
 * The probe therefore runs from a temp directory that is not inside the package
 * and has no node_modules above it, which is what a chunk's location does to
 * resolution. Both halves are asserted in the same run, because the bare failure
 * is what makes the anchored success mean anything.
 */
describe("the toolchain resolves esbuild from a bundled location", () => {
  it("anchors on the package's own installation, where a bare specifier cannot reach", async () => {
    const outside = await mkdtemp(join(tmpdir(), "vendo-bundled-chunk-"));
    try {
      const toolchain = pathToFileURL(join(PACKAGE_DIR, "dist/apps/checking/toolchain.js")).href;
      const chunk = join(outside, "chunk.mjs");
      // `.mjs` in a directory with no package.json above it: Node reads it as a
      // module standing alone, which is the resolution context of a server chunk.
      await writeFile(chunk, [
        `const { esbuildEntry } = await import(${JSON.stringify(toolchain)});`,
        "const out = { anchored: esbuildEntry() };",
        // The PRE-FIX behaviour, from this same module: a bare specifier, whose
        // resolution starts here and finds nothing.
        'try { await import("esbuild"); out.bare = true; } catch { out.bare = false; }',
        // And the anchored one actually loads and compiles.
        "const esbuild = await import(out.anchored);",
        'out.transformed = esbuild.transformSync("const a = <b/>;", { loader: "tsx", format: "esm", target: "es2022" }).code.length > 0;',
        "process.stdout.write(JSON.stringify(out));",
      ].join("\n"), "utf8");
      const probe = JSON.parse(execFileSync(process.execPath, [chunk], { cwd: PACKAGE_DIR, encoding: "utf8" })) as
        { anchored: string; bare: boolean; transformed: boolean };

      // The teeth: from here a bare specifier does NOT resolve, so the anchored
      // one succeeding is the fix and not the layout being forgiving.
      expect(probe.bare, "a bare specifier resolved from outside the package — this probe proves nothing").toBe(false);
      expect(probe.anchored).not.toBe("esbuild");
      expect(probe.transformed).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
