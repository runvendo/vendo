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
 *      devDependencies deliberately do NOT count, while test files ARE scanned:
 *      a test-only @vendoai/* import must still be a declared, layer-legal
 *      dependency — devDeps are invisible to consumers and would let layering
 *      violations hide in tests. (Non-@vendoai devDeps like vitest are fine.)
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
  // the canonical umbrella is the only package allowed to depend on every block
  "@vendoai/vendo": "*",
  // the unscoped compatibility package is a thin alias of the canonical umbrella
  vendoai: ["@vendoai/vendo"],
  // orthogonal to the campaign (00-overview: "stays as-is"); no vendo deps
  "@vendoai/telemetry": [],
};

/** Retired names that only exist as pre-v0 npm publishes. */
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
    // a self-reference is not a cross-block edge (Node subpath self-resolution,
    // and the umbrella CLI's generated wiring snippets name their own package)
    name === pkg.name ||
    (allowed === "*" ? Object.hasOwn(LAYERS, name) : allowed.includes(name));

  // 1 + 2 on the manifest
  const declared = {
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
  for (const [dep, version] of Object.entries(declared)) {
    if (RETIRED.includes(dep)) {
      errors.push(`${pkg.name}: depends on retired quarry package "${dep}".`);
    } else if (dep.startsWith("@vendoai/") || dep === "vendoai") {
      if (!isAllowed(dep)) {
        errors.push(
          `${pkg.name}: dependency "${dep}" violates the layering rule (allowed: ${allowed === "*" ? "any block" : allowed.join(", ") || "none"}).`,
        );
      } else if (!String(version).startsWith("workspace:")) {
        // A registry range like "^0.2.0" would silently resolve to the OLD npm
        // publish instead of the workspace package — the quarry through the
        // back door. Every @vendoai/* edge must use the workspace: protocol
        // (pnpm rewrites it to a real range on publish). No peer exemption:
        // no @vendoai/* peer exists today, and a future one should be a
        // conscious edit here, not a silent pass.
        errors.push(
          `${pkg.name}: dependency "${dep}" must use the workspace: protocol (got "${version}") — a registry range resolves to pre-v0 npm publishes.`,
        );
      }
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
        } else if (!(name in declared) && name !== pkg.name) {
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
