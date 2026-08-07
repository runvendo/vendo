#!/usr/bin/env node
/**
 * Dependency guard — the wave-3 CI gate.
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
 *   4. ZOD FLOOR FOR ai PEERS — any package declaring "ai" in peerDependencies
 *      must also declare its own "zod" floor at ZOD_V4_EXPORT_FLOOR or higher.
 *      ai imports `zod/v4`; a host that pins an older zod satisfies ai's own
 *      peer range on paper (ai@6 declares "^3.25.76 || ^4.1.8") but still
 *      lacks the ./v4 subpath at runtime — zod 3.24.x has no ./v4 export,
 *      every 3.25.x patch from .0 onward does (verified empirically against
 *      the npm registry's published exports maps). pnpm then resolves the
 *      package's own low floor for a stale host lockfile entry and the
 *      host's post-init build fails with ERR_PACKAGE_PATH_NOT_EXPORTED
 *      ./v4 (skateshop landmine; six packages fixed in 174aa430, ui+agent
 *      missed and fixed alongside this rule).
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
import { fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) so a checkout path containing spaces or other
// URL-escaped characters decodes correctly — .pathname leaves "%20" undecoded.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES_DIR = join(ROOT, "packages");

/** package name → allowed @vendoai/* (and umbrella) deps. "*" = anything in the map. */
const LAYERS = {
  "@vendoai/core": [],
  "@vendoai/store": ["@vendoai/core"],
  "@vendoai/actions": ["@vendoai/core"],
  "@vendoai/guard": ["@vendoai/core"],
  "@vendoai/ui": ["@vendoai/core"],
  "@vendoai/apps": ["@vendoai/core"],
  // the door (10-mcp): depends on core only; the ui/tree shim arrives as a
  // prebuilt committed artifact (built by packages/ui/scripts), never an import
  "@vendoai/mcp": ["@vendoai/core"],
  // the product knowledge base (knowledge design v2): engines + ingestion behind
  // core's KnowledgeAdapter contract; core-only, like the other engine blocks
  "@vendoai/knowledge": ["@vendoai/core"],
  "@vendoai/automations": ["@vendoai/core", "@vendoai/apps"],
  // the harness runtime (build contract 2026-07-30 §2): the second multi-block
  // package after the umbrella. It runs any Harness — building the Turn, mapping
  // the guard's outcomes, mirroring onto today's wire, and emitting hot-path
  // views — and since the engine fold it OWNS the turn loop too, so it reaches
  // core (the contract), apps (the plan skeleton) and guard, and nothing else.
  // It is NOT the umbrella: no store, no actions.
  "@vendoai/harnesses": ["@vendoai/core", "@vendoai/apps", "@vendoai/guard"],
  // the standalone agent runtime (agents-v0 spec, 2026-08-04): the open-source
  // front door Vendo's embed consumes across a real seam. It assembles what the
  // umbrella assembles — harness runtime (harnesses), guard, store, host tools
  // and MCP connectors (actions), and the e2b sandbox adapter (apps) — but it
  // is NOT the umbrella: no @vendoai/vendo, ever (the spec's dependency law;
  // the embed consumes agents, never the reverse).
  //
  // knowledge LEFT with the dead `vendoKnowledge` re-export (#982): the runtime
  // reaches knowledge engines through core's KnowledgeAdapter, so the direct
  // edge had no importer. An allow-list entry with no edge behind it is a hole
  // in the gate — it permits what nobody intends — so it goes when the edge does.
  //
  // mcp joined for the TOOL DOOR (Amendment 2, 2026-08-05): a harness declaring
  // `requires.toolDoor` thinks outside this process and reaches the host's
  // tools by dialling back, so the standalone runtime has to mount the door's
  // SERVER half (`createMcpDoor({ internal: true })`) exactly as the umbrella
  // does. mcp depends on core alone, so there is no cycle and the umbrella is
  // not dragged in; the cost is that a standalone install now carries
  // @modelcontextprotocol/sdk and jose, which is accepted.
  "@vendoai/agents": [
    "@vendoai/core",
    "@vendoai/actions",
    "@vendoai/apps",
    "@vendoai/guard",
    "@vendoai/harnesses",
    "@vendoai/mcp",
    "@vendoai/store",
  ],
  // the universal box app template (blueprint §11): what every generated app is
  // built FROM inside its box, baked once per Vendo release. Private, never
  // published, and deliberately reaches ONLY the browser layer — it imports the
  // code-land runtime through `@vendoai/ui/kit`, and an app in a box must never
  // be able to import a server block.
  // core joins for the DECLARED port contract (VENDO_DEV_PORT): the host that
  // mints the preview URL and the template that binds the socket must read one
  // constant, and they sit in different layers. core is the contract layer, not a
  // server block, so this does not weaken "an app in a box imports no server".
  "@vendoai/box-template": ["@vendoai/core", "@vendoai/ui"],
  // the canonical umbrella is the only package allowed to depend on every block
  "@vendoai/vendo": "*",
  // the unscoped compatibility package is a thin alias of the canonical umbrella
  vendoai: ["@vendoai/vendo"],
  // orthogonal to the campaign (00-overview: "stays as-is"); no vendo deps
  "@vendoai/telemetry": [],
};

/**
 * First zod 3.25.x patch confirmed (empirically, against the npm registry's
 * published exports maps) to ship the `./v4` subpath — 3.24.x has no ./v4
 * export at all; every 3.25.x patch checked, from .0 through ai@6.0.28's own
 * peer floor 3.25.76, already has it. Packages declaring "ai" as a peer must
 * carry a zod floor at least this high (rule 4 above).
 */
const ZOD_V4_EXPORT_FLOOR = [3, 25, 0];

/** One comparator: an operator (or none) over a possibly-partial version —
 * "^3.25.0", "~3.25.0", ">=3.25.0", ">= 3.25.0", "3.25.76", "<5". A missing
 * minor or patch reads as 0, which is what npm means by them in a lower bound
 * ("^3" is >=3.0.0, "3.25" is >=3.25.0). Wildcards ("3.25.x", "*"), prereleases
 * ("3.25.0-beta.1") and the hyphen range's bare "-" deliberately do NOT match.
 *
 * Sticky, and it absorbs the whitespace on both sides, because npm allows a
 * space BETWEEN an operator and its version (">= 3.25.0"). The operator and its
 * version are therefore one token that the scanner walks over; whitespace only
 * separates COMPLETE comparators. Splitting on bare whitespace instead would
 * fragment ">= 3.25.0 < 5" into ">=", "3.25.0", "<", "5" and strand both
 * operators. `\d+` is required, so a match is never empty and the walk always
 * advances. */
const COMPARATOR = /\s*(\^|~|>=|>|<=|<|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*/y;

/** Operators whose version is a ceiling. They cannot raise a floor, so the
 * floor scan skips them — but they are still a shape we understand, which is
 * the whole point: ">=3.25.0 <5" has a floor, it is just not the last token. */
const CEILING_OPERATORS = new Set(["<", "<="]);

/** Extracts a [major, minor, patch] floor from a semver range.
 *
 * A range is a `||` union of alternatives, and each alternative is a
 * whitespace-separated INTERSECTION of comparators — the shape every `ai`-peer
 * package in this repo uses for its zod peer, ">=3.25.0 <5". Each alternative
 * is SCANNED comparator by comparator rather than split on whitespace, so the
 * equally legal ">= 3.25.0 < 5" reads the same; anything left over when the
 * scan stalls is a shape we do not model. An alternative's
 * floor is the highest of its lower bounds (an intersection can only narrow);
 * the range's floor is the lowest across alternatives, because a union is only
 * as safe as the oldest zod it admits. `>x.y.z` is read as a floor of x.y.z —
 * an epsilon low, which can only make the guard stricter, never laxer.
 *
 * Returns null for any shape this cannot model — a wildcard, a prerelease, a
 * hyphen range, or an alternative that is all ceiling ("<5", which admits
 * zod 1.0.0). The caller turns null into a loud failure: a version gate that
 * quietly accepts what it cannot read is worse than one that errors. */
function parseVersionFloor(range) {
  let floor = null;
  for (const alternative of String(range).split("||")) {
    const text = alternative.trim();
    let alternativeFloor = null;
    COMPARATOR.lastIndex = 0;
    while (COMPARATOR.lastIndex < text.length) {
      const match = COMPARATOR.exec(text);
      if (!match) return null;
      if (CEILING_OPERATORS.has(match[1])) continue;
      const version = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
      if (!alternativeFloor || compareVersions(version, alternativeFloor) > 0) {
        alternativeFloor = version;
      }
    }
    if (!alternativeFloor) return null;
    if (!floor || compareVersions(alternativeFloor, floor) < 0) floor = alternativeFloor;
  }
  return floor;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

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

  // 4 on the manifest
  if (pkg.peerDependencies?.ai) {
    const zodRange = pkg.dependencies?.zod ?? pkg.peerDependencies?.zod;
    if (!zodRange) {
      errors.push(
        `${pkg.name}: declares "ai" in peerDependencies but no "zod" floor — ai imports zod/v4, so a host's older pinned zod satisfies ai's peer range yet lacks the ./v4 export at runtime (ERR_PACKAGE_PATH_NOT_EXPORTED).`,
      );
    } else {
      const floor = parseVersionFloor(zodRange);
      if (!floor) {
        errors.push(
          `${pkg.name}: "zod" range "${zodRange}" has no modelable floor (rule 4 reads ^ ~ >= > <= = comparators over whole x[.y[.z]] versions, space-intersected and ||-unioned, e.g. ">=3.25.0 <5"; wildcards, prereleases and hyphen ranges are not modeled) — declare a floor at or above ${ZOD_V4_EXPORT_FLOOR.join(".")}.`,
        );
      } else if (compareVersions(floor, ZOD_V4_EXPORT_FLOOR) < 0) {
        errors.push(
          `${pkg.name}: "zod" floor "${zodRange}" is below ${ZOD_V4_EXPORT_FLOOR.join(".")}, the first zod release with the ./v4 export ai needs — raise it (see 174aa430).`,
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
    "\nThe layering contract is enumerated at the top of scripts/dependency-guard.mjs.",
  );
  process.exit(1);
}

console.log(`dependency-guard: OK (${dirs.length} packages checked)`);
