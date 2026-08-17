#!/usr/bin/env node
/**
 * Dependency guard — the wave-3 CI gate.
 *
 * Enforces, for EVERY package in the workspace — the blocks under packages/ and
 * the consumers under fixtures/, examples/ and corpus/ alike:
 *
 *   1. LAYERING — the only allowed @vendoai/* edges are:
 *        core → (nothing)
 *        apps → core            automations → core
 *        store, agent, actions, guard, ui → core
 *        vendo (umbrella) → everything
 *      A packages/* block not in the map fails loudly: adding a block means
 *      consciously adding its layer here. A consumer outside packages/ is not a
 *      block and sits above every layer, so it may depend on any block in the
 *      map — but rules 2 and 3 bind it exactly as they bind a block.
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
 *   5. ONE ZOD PEER RANGE — every published block that lists "zod" in
 *      dependencies must declare the SAME zod peer, ZOD_PEER_RANGE. The peer is
 *      what makes pnpm bind the HOST's zod; a block with only the dependency
 *      keeps its own copy, so on a host pinning another zod major the block set
 *      splits into two zod instances and a schema built in one is not a schema
 *      in the other — core's riskLabelSchema inside guard's z.object threw
 *      "expected a Zod schema" and every tool call died (#1314). Uniform or
 *      nothing: a mixed posture is what split the set. Private packages are
 *      apps, not libraries — they have no consumer to share zod with.
 *
 * Runs in `pnpm lint` at the root. No dependencies; Node >= 20.
 *
 * Known residual gaps (accepted): computed dynamic imports (import(`@vendoai/${x}`))
 * and tsconfig path aliases are invisible to a static text scan; PR review covers
 * them. The scan may also match import-shaped strings inside comments, or inside
 * source a package GENERATES for somewhere else (corpus/harness emits a Next
 * layout for the corpus app) — a false positive fails loudly and is fixed by
 * rewording, never by loosening the gate.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) so a checkout path containing spaces or other
// URL-escaped characters decodes correctly — .pathname leaves "%20" undecoded.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** package name → allowed @vendoai/* (and umbrella) deps. "*" = anything in the map. */
const LAYERS = {
  "@vendoai/core": [],
  "@vendoai/store": ["@vendoai/core", "@vendoai/apps"],
  "@vendoai/actions": ["@vendoai/core", "@vendoai/apps"],
  "@vendoai/guard": ["@vendoai/core"],
  // ui reaches app generation ONLY through the browser-safe contract door —
  // enforced by ONLY_SUBPATHS below, not by this list.
  "@vendoai/ui": ["@vendoai/core", "@vendoai/apps"],
  "@vendoai/apps": ["@vendoai/core"],
  // the door (10-mcp): depends on core only; the ui/tree shim arrives as a
  // prebuilt committed artifact (built by packages/ui/scripts), never an import
  "@vendoai/mcp": ["@vendoai/core", "@vendoai/apps"],
  // the product knowledge base (knowledge design v2): engines + ingestion behind
  // core's KnowledgeAdapter contract; core-only, like the other engine blocks
  "@vendoai/knowledge": ["@vendoai/core"],
  // The layering flip (automations centralization): an automation is a
  // first-class RECORD with no app reference of any kind, so this package has
  // ZERO app concepts and this line is the machine-checkable proof of it. A
  // task reaches an app only by naming one of its functions as an ordinary
  // granted tool, which resolves through the tool registry like any other.
  "@vendoai/automations": ["@vendoai/core"],
  // the harness runtime (build contract 2026-07-30 §2): the second multi-block
  // package after the umbrella. It runs any Harness — building the Turn, mapping
  // the guard's outcomes, mirroring onto today's wire — and since the engine
  // fold it OWNS the turn loop too. core (the contract) and guard ONLY: the
  // render seam, validate gate and screen agent moved out (apps, apps, and the
  // umbrella respectively), hot-path views ride the runtime's generic
  // `wrapWorkspace` slot, and the claude-code driver is apps-free since the
  // claude-turn rehome — the session runner (`claude-code/claude-turn.ts`) and
  // the box session door (`box/turn-routes.mjs`) live HERE now, and the apps
  // vocabulary the driver still uses (hot paths, the validate gate) arrives
  // INJECTED through `provideHarnessAdapters` from composition (the umbrella
  // and @vendoai/agents), never imported. The e2b/box-door seam tests live in
  // packages/vendo/tests, where both blocks are legal.
  // It is NOT the umbrella: no store, no actions.
  //
  // apps joined for the MODEL LADDER (agents-dx P1): `vendoModel()` moved here
  // from @vendoai/vendo so the standalone agent runtime can fill its model slot
  // without an umbrella edge, and the ladder re-decides sampling params against
  // the RESOLVED rung — `acceptsSamplingParams` in apps' model-params.ts, the
  // one place that rule is stated. apps depends on core alone, so there is no
  // cycle; the cost is that a standalone install carries apps, which is accepted.
  "@vendoai/harnesses": ["@vendoai/core", "@vendoai/guard", "@vendoai/apps"],
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
 * consumer → the ONLY specifiers it may use for a given package.
 *
 * The scan below reduces every specifier to its package name, so a subpath rule
 * is matched on the RAW specifier. An ALLOW-list, not a ban list: `@vendoai/apps`
 * root is the node-only engine and `@vendoai/apps/contract` is its browser-safe
 * half, so a ban list would let a future node-only subpath through by default.
 * Browser code reaches the contract and never the root.
 *
 * Keyed on the CONSUMER's package name, so it covers `packages/*` only —
 * `examples/` and `fixtures/` are scanned for layering but get no subpath rule.
 * That matches the intended scope (the ban exists to keep the browser package
 * off the node-only door), but it is worth knowing before you rely on it.
 */
const ONLY_SUBPATHS = {
  "@vendoai/ui": { "@vendoai/apps": ["@vendoai/apps/contract"] },
};

/**
 * First zod 3.25.x patch confirmed (empirically, against the npm registry's
 * published exports maps) to ship the `./v4` subpath — 3.24.x has no ./v4
 * export at all; every 3.25.x patch checked, from .0 through ai@6.0.28's own
 * peer floor 3.25.76, already has it. Packages declaring "ai" as a peer must
 * carry a zod floor at least this high (rule 4 above).
 */
const ZOD_V4_EXPORT_FLOOR = [3, 25, 0];

/** The one zod peer range every published block that bundles zod declares (rule 5). */
const ZOD_PEER_RANGE = ">=3.25.0 <5";

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

/** Directories that hold generated output rather than authored source. `dist` and
 * `node_modules` were always skipped; the rest matter now that the scan reaches
 * fixtures/ and examples/, where a `next build` or a Playwright run drops bundled
 * chunks INSIDE a scanned package. A bundle is full of import-shaped strings and
 * would fail the gate on code nobody wrote. All are gitignored; nothing tracked
 * in this repo lives under any of them (`.vendo/`, which IS tracked and does hold
 * source, is deliberately absent). */
const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "test-results",
]);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (GENERATED_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(p);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(entry.name)) yield p;
  }
}

const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gm;

/** Every package directory in the workspace, read out of pnpm-workspace.yaml.
 *
 * Derived, never hardcoded: the scan root used to be the literal `packages/`, so
 * fixtures/, examples/ and corpus/ were never looked at — and an
 * undeclared cross-package import had been sitting in fixtures/integration-browser
 * the whole time, breaking a rule that already existed and simply never ran there.
 * Reading the workspace's own definition is the only way that gap cannot reopen
 * the next time a root is added.
 *
 * Only the two entry shapes this file uses are understood: a literal path, and a
 * `<parent>/*` glob. Anything else throws, because a silently unscanned directory
 * is the defect above. */
function workspacePackageDirs() {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const list = /^packages:[^\S\n]*\n((?:[^\S\n]+-[^\n]*\n)+)/m.exec(yaml)?.[1];
  if (!list) throw new Error("dependency-guard: no `packages:` list in pnpm-workspace.yaml");
  const dirs = [];
  for (const line of list.trimEnd().split("\n")) {
    const pattern = /^\s*-\s*["']?([^"'\s]+)["']?$/.exec(line)?.[1];
    if (!pattern) throw new Error(`dependency-guard: unreadable workspace entry: ${line.trim()}`);
    if (!pattern.includes("*")) {
      dirs.push(pattern);
    } else if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(ROOT, parent, entry.name, "package.json"))) {
          dirs.push(`${parent}/${entry.name}`);
        }
      }
    } else {
      throw new Error(`dependency-guard: unsupported workspace glob "${pattern}"`);
    }
  }
  return dirs;
}

const dirs = workspacePackageDirs();

for (const dir of dirs) {
  const packageRoot = join(ROOT, dir);
  const pkgPath = join(packageRoot, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // Outside packages/ a package is a CONSUMER, not a block: it sits above every
  // layer, so any block in the map is a legal dependency. Only a block missing
  // from the map is a mistake — that is the conscious-layer rule, and widening it
  // to consumers would demand a layer for every fixture and example.
  const allowed = LAYERS[pkg.name] ?? (dir.startsWith("packages/") ? undefined : "*");

  if (allowed === undefined) {
    errors.push(
      `${pkg.name} (${dir}): not in the dependency-guard layer map — add it to scripts/dependency-guard.mjs with its allowed layer (00-overview.md, "The dependency rule").`,
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

  // 5 on the manifest
  if (!pkg.private && pkg.dependencies?.zod && pkg.peerDependencies?.zod !== ZOD_PEER_RANGE) {
    errors.push(
      `${pkg.name}: bundles "zod" as a dependency but its zod peer is "${pkg.peerDependencies?.zod ?? "missing"}", not "${ZOD_PEER_RANGE}" — declare the same peer as every other block (#1314).`,
    );
  }

  // 2 + 3 on the sources
  for (const file of sourceFiles(packageRoot)) {
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
        if (!(resolved + sep).startsWith(packageRoot + sep)) {
          errors.push(`${rel}: relative import "${spec}" escapes its package directory.`);
        }
        continue;
      }
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      const only = ONLY_SUBPATHS[pkg.name]?.[name];
      if (only && !only.includes(spec)) {
        errors.push(
          `${rel}: imports "${spec}" — ${pkg.name} may reach ${name} only through ${only.join(", ")}.`,
        );
      }
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
