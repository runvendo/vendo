#!/usr/bin/env node
/**
 * Dependency guard — the wave-3 CI gate (docs/contracts/00-overview.md).
 *
 * Enforces, for every package in the active workspace (packages/*):
 *
 *   1. LAYERING — the only allowed @vendoai/* edges are:
 *        core → (nothing)
 *        apps → core            automations → apps, core
 *        store, agent, actions, guard, ui → core
 *        vendo (umbrella) → everything
 *      A package not in the map fails loudly: adding a package means
 *      consciously adding its layer here.
 *
 *   2. NO QUARRY IMPORTS — nothing may import from legacy/ (path or relative
 *      escape), and nothing may import the retired package names that only
 *      exist in the quarry / on old npm (@vendoai/cli, client, components,
 *      react, runtime, server, shell, stage) — those would silently resolve
 *      to the pre-v0 published versions.
 *
 *   3. HONEST MANIFESTS — every @vendoai/* import in a package's src must be
 *      declared in its package.json (dependencies or peerDependencies).
 *
 * Runs in `pnpm lint` at the root. No dependencies; Node >= 20.
 *
 * Known residual gaps (accepted): computed dynamic imports (import(`@vendoai/${x}`))
 * and tsconfig path aliases are invisible to a static text scan; PR review covers
 * them. The scan may also match import-shaped strings inside comments — a false
 * positive fails loudly and is fixed by rewording, never by loosening the gate.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES_DIR = join(ROOT, "packages");

/** package name → allowed @vendoai/* (and umbrella) deps. "*" = anything in the map. */
const LAYERS = {
  "@vendoai/core": [],
  "@vendoai/store": ["@vendoai/core"],
  "@vendoai/agent": ["@vendoai/core"],
  "@vendoai/actions": ["@vendoai/core"],
  "@vendoai/guard": ["@vendoai/core"],
  "@vendoai/ui": ["@vendoai/core"],
  "@vendoai/apps": ["@vendoai/core"],
  "@vendoai/automations": ["@vendoai/core", "@vendoai/apps"],
  // the umbrella (published as `vendoai`) is the only package allowed to depend on everything
  vendoai: "*",
  // orthogonal to the campaign (00-overview: "stays as-is"); no vendo deps
  "@vendoai/telemetry": [],
};

/** Retired names that only exist in the quarry / as pre-v0 npm publishes. */
const RETIRED = [
  "@vendoai/cli",
  "@vendoai/client",
  "@vendoai/components",
  "@vendoai/react",
  "@vendoai/runtime",
  "@vendoai/server",
  "@vendoai/shell",
  "@vendoai/stage",
];

const errors = [];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(p);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(entry.name)) yield p;
  }
}

const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gm;

const dirs = readdirSync(PACKAGES_DIR).filter((d) =>
  statSync(join(PACKAGES_DIR, d)).isDirectory(),
);

for (const dir of dirs) {
  const pkgPath = join(PACKAGES_DIR, dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const allowed = LAYERS[pkg.name];

  if (allowed === undefined) {
    errors.push(
      `${pkg.name} (packages/${dir}): not in the dependency-guard layer map — add it to scripts/dependency-guard.mjs with its allowed layer (00-overview.md, "The dependency rule").`,
    );
    continue;
  }

  const isAllowed = (name) =>
    allowed === "*" ? Object.hasOwn(LAYERS, name) && name !== pkg.name : allowed.includes(name);

  // 1 + 2 on the manifest
  const declared = {
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
  for (const dep of Object.keys(declared)) {
    if (RETIRED.includes(dep)) {
      errors.push(`${pkg.name}: depends on retired quarry package "${dep}".`);
    } else if ((dep.startsWith("@vendoai/") || dep === "vendoai") && !isAllowed(dep)) {
      errors.push(
        `${pkg.name}: dependency "${dep}" violates the layering rule (allowed: ${allowed === "*" ? "any block" : allowed.join(", ") || "none"}).`,
      );
    }
  }

  // 2 + 3 on the sources
  for (const file of sourceFiles(join(PACKAGES_DIR, dir))) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(ROOT.length);
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec.includes("legacy/")) {
        errors.push(`${rel}: imports from the quarry ("${spec}").`);
        continue;
      }
      if (spec.startsWith(".")) {
        // A relative import must stay inside its own package — an escape can
        // reach the quarry or a sibling block without naming either.
        const resolved = resolve(dirname(file), spec);
        const packageRoot = join(PACKAGES_DIR, dir) + sep;
        if (!(resolved + sep).startsWith(packageRoot)) {
          errors.push(`${rel}: relative import "${spec}" escapes its package directory.`);
        }
        continue;
      }
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (RETIRED.includes(name)) {
        errors.push(`${rel}: imports retired quarry package "${name}".`);
      } else if (name.startsWith("@vendoai/") || name === "vendoai") {
        if (!isAllowed(name)) {
          errors.push(`${rel}: import of "${name}" violates the layering rule.`);
        } else if (!(name in declared)) {
          errors.push(`${rel}: imports "${name}" without declaring it in package.json.`);
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error("dependency-guard: FAILED\n");
  for (const e of errors) console.error("  ✗ " + e);
  console.error(
    "\nThe layering contract lives in docs/contracts/00-overview.md (\"The dependency rule\").",
  );
  process.exit(1);
}

console.log(`dependency-guard: OK (${dirs.length} packages checked)`);
