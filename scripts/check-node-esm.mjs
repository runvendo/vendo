#!/usr/bin/env node
/**
 * Node-ESM loadability smoke test for the publishable library packages.
 *
 * For every non-private package under packages/* (plus @vendoai/sandbox-shims,
 * which is private but ships into the sandbox bundle), dynamically import()s
 * every runtime entrypoint declared in its package.json "exports" map from the
 * built dist, in a plain Node subprocess (no bundler, no loader hooks).
 *
 * This is the gate for "dists need NodeNext before ENG-198": plain `tsc` under
 * moduleResolution Bundler emits extensionless relative specifiers that Node
 * rejects with ERR_MODULE_NOT_FOUND.
 *
 * Exit code 0 iff every entrypoint imports cleanly (or is explicitly
 * allowlisted below as browser-only).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(repoRoot, "packages");

/**
 * Entrypoints that legitimately cannot load under plain Node because they
 * touch browser globals at module-evaluation time. Keep this list empty
 * unless a failure is proven to be a DOM-global access (not a resolution
 * error) — resolution errors are always bugs.
 *
 * Format: "<package-name> <export-subpath>" -> reason string.
 */
const BROWSER_ONLY_ALLOWLIST = new Map([
  // These entrypoints are React UI surfaces meant to be consumed by a bundler
  // (Next.js, Vite, ...). They side-effect-import stylesheets at module scope
  // — @vendoai/shell imports its own ./styles.css, and @vendoai/components /
  // @vendoai/next/client pull in @openuidev/react-ui which imports its CSS —
  // so plain Node rejects them with ERR_UNKNOWN_FILE_EXTENSION (".css").
  // That is inherent to CSS-in-ESM, not an extensionless-specifier bug; every
  // relative JS specifier in these dists carries an explicit extension.
  ["@vendoai/components .", "CSS side-effect import via @openuidev/react-ui"],
  ["@vendoai/components ./sandbox", "CSS side-effect import via @openuidev/react-ui"],
  ["@vendoai/next ./client", "CSS side-effect import via @openuidev/react-ui"],
  ["@vendoai/shell .", "side-effect import of ./styles.css"],
]);

function collectRuntimeTargets(exportsField) {
  // Returns [subpath, relativeTarget][] for runtime JS entrypoints.
  const targets = [];
  if (!exportsField || typeof exportsField !== "object") return targets;
  for (const [subpath, value] of Object.entries(exportsField)) {
    let target = value;
    while (target && typeof target === "object") {
      // Prefer runtime conditions; never "types".
      target =
        target.node ?? target.import ?? target.default ?? target.require ?? null;
    }
    if (typeof target !== "string") continue;
    if (!target.endsWith(".js") && !target.endsWith(".mjs") && !target.endsWith(".cjs")) {
      continue; // e.g. ./styles.css
    }
    targets.push([subpath, target]);
  }
  return targets;
}

function tryImport(fileUrl) {
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(fileUrl)});`],
    { encoding: "utf8", timeout: 30_000 }
  );
  return {
    ok: res.status === 0,
    stderr: (res.stderr ?? "").trim(),
  };
}

let checked = 0;
let failed = 0;
let skipped = 0;

for (const dir of readdirSync(packagesDir).sort()) {
  const pkgJsonPath = path.join(packagesDir, dir, "package.json");
  if (!existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const includeAnyway = pkg.name === "@vendoai/sandbox-shims";
  if (pkg.private && !includeAnyway) continue;

  const targets = collectRuntimeTargets(pkg.exports);
  if (targets.length === 0) continue;

  console.log(`\n${pkg.name}`);
  for (const [subpath, target] of targets) {
    const allowKey = `${pkg.name} ${subpath}`;
    const filePath = path.join(packagesDir, dir, target);
    checked++;
    if (!existsSync(filePath)) {
      failed++;
      console.log(`  FAIL  ${subpath} -> ${target} (dist file missing — run pnpm build)`);
      continue;
    }
    const { ok, stderr } = tryImport(String(new URL(`file://${filePath}`)));
    if (ok) {
      console.log(`  PASS  ${subpath} -> ${target}`);
    } else if (
      BROWSER_ONLY_ALLOWLIST.has(allowKey) &&
      stderr.includes("ERR_UNKNOWN_FILE_EXTENSION") &&
      stderr.includes(".css")
    ) {
      // Browser-only entrypoint: the import got past all JS resolution and
      // died on a stylesheet, which is the documented, expected limit.
      skipped++;
      console.log(
        `  SKIP  ${subpath} -> ${target} (browser-only: ${BROWSER_ONLY_ALLOWLIST.get(allowKey)})`
      );
    } else {
      failed++;
      const firstError =
        stderr.split("\n").find((l) => l.includes("Error")) ?? stderr.split("\n")[0] ?? "";
      console.log(`  FAIL  ${subpath} -> ${target}`);
      console.log(`        ${firstError.trim()}`);
    }
  }
}

console.log(
  `\n${checked} entrypoints checked, ${checked - failed - skipped} passed, ${failed} failed, ${skipped} browser-only (allowlisted, JS resolution verified)`
);
process.exit(failed > 0 ? 1 : 0);
