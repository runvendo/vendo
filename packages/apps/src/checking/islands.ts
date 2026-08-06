/**
 * Island admission — one island through the ambient contract: normalize the
 * wrapper, silently strip the known react/kit imports (pretraining habit),
 * gate the rest, and infer the per-island tool manifest from the literal
 * `tools` member chains (validated against the live registry when the host
 * supplied one).
 */
import {
  KIT_WIRE_COMPONENT_NAMES,
  RESERVED_COMPONENT_NAMES,
  WIRE_COMPONENT_NAMES,
  ISLAND_AMBIENT_KIT_NAMES,
  ISLAND_STRIPPED_SPECIFIERS,
  islandDerivedValueViolations,
  islandNetworkViolations,
  resolveIslandToolName,
  scanIslandTools,
  stripIslandImports,
} from "@vendoai/core";
import { hasDefaultExport } from "../pins.js";
import type { HostToolInfo } from "./deps.js";

/** Models wrap island TSX in a JSX template-literal expression (`{`…`}`)
 *  despite instructions; strip it deterministically, the way the engine's
 *  extractWire strips fences. */
const ISLAND_WRAPPER = /^\{\s*`([\s\S]*)`\s*\}$/;
const normalizeIslandSource = (source: string): string => {
  const trimmed = source.trim();
  const match = ISLAND_WRAPPER.exec(trimmed);
  return match === null ? trimmed : (match[1] as string).trim();
};

/** TSX syntax gate for island sources. esbuild loads lazily (same pattern as
 *  the "ai" import); when unavailable the syntax check is skipped and the
 *  default-export check still applies.
 *
 *  The magic comments below are bundler directives, not runtime code — Node
 *  ignores them and this stays a plain dynamic import (proven: still works
 *  under Vitest's vm-sandboxed test runner, unlike a `new Function`-built
 *  indirection, which throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING there).
 *  `webpackIgnore`/`turbopackIgnore` tell the bundler to skip resolving this
 *  specific specifier at build time instead of walking into esbuild's
 *  package — which is where the real damage happens: esbuild's own
 *  lib/main.js resolves its native binary with a dynamic require, and once a
 *  bundler is inside esbuild's module graph at all, it tries to parse the
 *  platform binary and its README.md as JS and hard-fails the build.
 *  Confirmed empirically: without these comments (or `serverExternalPackages:
 *  ["esbuild"]` in the host's next.config), `next build` on a host importing
 *  "@vendoai/vendo/server" fails with "Unknown module type" /
 *  "invalid utf-8 sequence" on esbuild's platform binary; with them, the
 *  same host builds clean with esbuild left OUT of `serverExternalPackages`
 *  entirely. */
/** Routed through a mutable binding so NO bundler statically resolves the
    optional validator: the ignore comments above only speak webpack dialect,
    and Wrangler (esbuild-the-bundler) inlined esbuild-the-package into Worker
    bundles, where its lib/main.js dies on `__filename` the moment the
    transform runs — misread below as "invalid TSX", failing EVERY island and
    therefore every app build on Workers (the 2026-07 field report's
    apps-create death; same class as the e2b import). */
let ESBUILD_SPECIFIER = "esbuild";

const esbuildTransform = (async () => {
  try {
    const esbuild = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ ESBUILD_SPECIFIER) as { transformSync: (source: string, options: { loader: string }) => unknown };
    return (source: string) => void esbuild.transformSync(source, { loader: "tsx" });
  } catch {
    return undefined;
  }
})();

/** Every module specifier an island source imports — static (`import … from`,
 *  side-effect `import "x"`, `export … from`), dynamic `import("x")`, and
 *  `require("x")`. The jail's sucrase loader rewrites all of these to its
 *  require table, so any specifier here that is not an island-resolvable
 *  module (`ISLAND_STRIPPED_SPECIFIERS`) cannot resolve at runtime.
 *
 *  Deliberately the STRIPPED set, not the wider resolvable one: the jail also
 *  bundles clsx/tailwind-merge/zod for captured HOST components, but a
 *  GENERATED island must not reach them. The smoke-render gate evaluates
 *  islands with `require = () => ({})`, so permitting an import it cannot
 *  resolve would trade this gate's precise message for a confusing render
 *  crash one stage later. Islands have the ambient Kit; they do not need
 *  packages. */
const IMPORT_SPECIFIER =
  /(?:\bimport\b|\bexport\b)[^'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

const islandImportSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

const ISLAND_RESOLVABLE_MODULE_SET = new Set<string>(ISLAND_STRIPPED_SPECIFIERS);

// ---------------------------------------------------------------------------
// Host-component-in-island teaching. Rematch gate 2026-07-25: 17+ Cadence and
// several Maple creates burned EVERY repair round on islands rendering
// <CadenceStatusBadge>/<MapleSparkline>/<Skeleton> — the issue string named
// the whole ambient list but no concrete substitution, so repair reproduced
// the class instead of fixing it. Each offending tag now carries the specific
// ambient Kit equivalent the rewrite should use.
// ---------------------------------------------------------------------------

/** A loading placeholder has no ambient equivalent — the substitution is a
 *  loading STATE, not a component. */
const LOADING_PLACEHOLDER = /skeleton|spinner|loader|shimmer/i;

/** Keyword → ambient Kit vocabulary for host component names whose suffix is
 *  not itself an ambient name. Ordered: first hit wins. */
const KIT_VOCABULARY: ReadonlyArray<readonly [RegExp, string]> = [
  [/status/i, "EnumBadge"],
  [/badge|pill|chip/i, "Badge"],
  [/sparkline/i, "Sparkline"],
  [/donut|pie/i, "DonutChart"],
  [/bar\s*chart|histogram/i, "BarChart"],
  [/chart|graph|trend/i, "LineChart"],
  [/progress|meter|gauge/i, "Progress"],
  [/table|datagrid/i, "DataTable"],
  [/stat|metric|kpi|tile/i, "Stat"],
  [/callout|banner|alert|notice/i, "Callout"],
  [/card|panel|surface/i, "Surface"],
  [/list|feed/i, "CardList"],
  [/money|amount|currency|price/i, "Money"],
  [/date|time/i, "DateTime"],
];

const AMBIENT_KIT_SET = new Set<string>(ISLAND_AMBIENT_KIT_NAMES);

/** The ambient Kit component an island should render in place of a host
 *  catalog / non-ambient prewired name — teaching heuristic for the repair
 *  prompt, never a rewrite the engine performs itself. Undefined when the
 *  name is a loading placeholder (the substitution is a loading state) or
 *  maps to nothing recognizable. */
export const ambientKitEquivalent = (name: string): string | undefined => {
  if (LOADING_PLACEHOLDER.test(name)) return undefined;
  // "…StatusBadge" wants the ENUM badge, so the status keyword outranks the
  // Badge suffix.
  if (/status/i.test(name)) return "EnumBadge";
  // An ambient-name suffix is the strongest signal: MapleSparkline →
  // Sparkline, CadenceDocProgress → Progress (longest match wins).
  let suffix: string | undefined;
  for (const kitName of AMBIENT_KIT_SET) {
    if (name.length > kitName.length && name.endsWith(kitName)
      && (suffix === undefined || kitName.length > suffix.length)) {
      suffix = kitName;
    }
  }
  if (suffix !== undefined) return suffix;
  for (const [pattern, kitName] of KIT_VOCABULARY) {
    if (pattern.test(name)) return kitName;
  }
  return undefined;
};

/** One teaching issue per offending tag, naming the concrete substitution so
 *  a repair round can act (the generic all-ambient-names list demonstrably
 *  did not converge — rematch 2026-07-25). */
const hostTagIssue = (island: string, tag: string): string => {
  const equivalent = ambientKitEquivalent(tag);
  const substitution = equivalent !== undefined
    ? `use the ambient Kit equivalent (${equivalent}) inside the island, or move it to a tree node`
    : LOADING_PLACEHOLDER.test(tag)
      ? `islands render against live tool data — replace it with a brief loading state (e.g. <Text text="Loading…"/> until the data arrives), or move it to a tree node`
      : `use one of the ambient Kit components inside the island (${ISLAND_AMBIENT_KIT_NAMES.join(", ")}), or move it to a tree node`;
  return `island "${island}" renders <${tag}> — <${tag}> renders on the host page and cannot exist inside an island (the name is undefined in the sandbox): ${substitution}.`;
};

export interface PreparedIslands {
  /** name → stripped canonical source. Empty record when there are no islands. */
  components: Record<string, string>;
  /** name → sorted registry tool names its source reaches (may be empty). */
  componentTools: Record<string, string[]>;
  issues: string[];
}

/** A broken island must never persist: it renders as a contained error
 *  instead of an app. Checked at create AND edit, routed to repair. An
 *  island reaching for a module the ambient scope cannot provide (the
 *  recharts class) error-boxes the whole app, so a disallowed import is
 *  rejected before the syntax gate; computed/aliased `tools` access and
 *  unknown tool names are rejected before they can reach the runtime. */
export const prepareIslands = async (
  rawComponents: Record<string, string>,
  tools: readonly HostToolInfo[] | undefined,
  hostComponents: readonly string[] = [],
  /** The user's request text — law 1 exempts constants that are the user's
   *  own numbers (see islandDerivedValueViolations). Absent → no carve-out. */
  requestText?: string,
): Promise<PreparedIslands> => {
  const issues: string[] = [];
  const components: Record<string, string> = {};
  const componentTools: Record<string, string[]> = {};
  const knownTools = tools === undefined ? undefined : new Set(tools.map((tool) => tool.name));
  // Host catalog + tree-resolvable components (prewired AND branded — a
  // non-ambient <Table>/<Card> dies exactly like <Skeleton>) render in the
  // HOST page — they can never cross into the opaque-origin jail, so an
  // island JSX tag naming one is a guaranteed ReferenceError (live example:
  // <MapleSpendingDonut/>). Names the ambient Kit also provides are fine —
  // the Kit version renders.
  const ambientNames = new Set<string>(ISLAND_AMBIENT_KIT_NAMES);
  const hostOnlyNames = [...new Set([...hostComponents, ...WIRE_COMPONENT_NAMES])]
    .filter((componentName) => !ambientNames.has(componentName));
  // Name resolution is host catalog → built-ins → islands, so an island NAMED
  // after any of those never renders: the built-in wins and the island is
  // dead weight. Reject the name itself → repair to a distinct one.
  const unreachableIslandNames = new Set<string>([
    ...hostComponents,
    ...RESERVED_COMPONENT_NAMES,
    ...KIT_WIRE_COMPONENT_NAMES,
  ]);
  let transform = await esbuildTransform;
  for (const [name, rawSource] of Object.entries(rawComponents)) {
    if (unreachableIslandNames.has(name)) {
      issues.push(`island "${name}" would never render — component names resolve host catalog → built-ins (Kit/prewired) → islands, so "${name}" always resolves to the built-in/host component instead. Rename the island to a distinct PascalCase name.`);
    }
    const stripped = stripIslandImports(normalizeIslandSource(rawSource));
    issues.push(...stripped.issues.map((issue) => `island "${name}" ${issue}`));
    const source = stripped.source.trim();
    components[name] = source;
    if (!hasDefaultExport(source)) {
      issues.push(`island "${name}" must be plain TSX with an \`export default\` component — no braces, template literals, or fences around the source`);
      continue;
    }
    const disallowed = [...new Set(islandImportSpecifiers(source))].filter((specifier) => !ISLAND_RESOLVABLE_MODULE_SET.has(specifier));
    if (disallowed.length > 0) {
      issues.push(`island "${name}" imports ${disallowed.map((specifier) => `"${specifier}"`).join(", ")} — islands have NO imports; React, the Kit components (including the ambient Kit charts), fmt, and tools are already in scope, and nothing else can load in the network-denied sandbox. Remove the import and use the ambient names.`);
      continue;
    }
    const hostTags = hostOnlyNames.filter((componentName) =>
      new RegExp(`<\\s*${componentName}\\b`).test(source)
      // A locally-declared component of the same name is the island's own:
      // the local binding wins inside the jail, so don't reject it.
      && !new RegExp(`\\b(?:function|const|let|var|class)\\s+${componentName}\\b`).test(source));
    for (const tag of hostTags) {
      issues.push(hostTagIssue(name, tag));
    }
    // The jail has no network: a habit-written fetch/XHR dies silently at the
    // CSP, so catch it here and repair to the ambient tools API instead.
    for (const api of islandNetworkViolations(source)) {
      issues.push(`island "${name}" calls ${api}(…) — an island has no network (the sandbox blocks fetch/XHR/WebSocket); the ambient tools API is the ONLY way to read or act: \`await tools.<tool_name>(args)\` with a HOST TOOLS name.`);
    }
    // Law 1 teeth for island math: a hand-typed constant feeding displayed
    // arithmetic over tool-derived values is invented data (the FX-rate
    // class).
    for (const violation of islandDerivedValueViolations(source, requestText === undefined ? undefined : { requestText })) {
      issues.push(`island "${name}" ${violation}`);
    }
    // The ambient tools contract: literal member access only, every chain
    // resolved against the live registry, the result stamped as the island's
    // entire runtime tool surface.
    const scan = scanIslandTools(source);
    issues.push(...scan.violations.map((violation) => `island "${name}" ${violation}`));
    const manifest = new Set<string>();
    for (const path of scan.paths) {
      if (knownTools === undefined) {
        manifest.add(path.join("_"));
        continue;
      }
      const resolved = resolveIslandToolName(path, knownTools);
      if (resolved === null) {
        issues.push(`island "${name}" calls unknown tool "tools.${path.join(".")}" — the host tools are: ${[...knownTools].join(", ")}`);
      } else {
        manifest.add(resolved);
      }
    }
    componentTools[name] = [...manifest].sort();
    if (transform === undefined) continue;
    try {
      transform(source);
    } catch (error) {
      // Only a real syntax verdict may fail the island: esbuild transform
      // errors carry an `errors` array. Anything else means the VALIDATOR
      // broke (a runtime without its native binary, an inlined bundle
      // resolving __filename) — best-effort validation degrades to none
      // instead of failing every island in the build.
      if (typeof error === "object" && error !== null && Array.isArray((error as { errors?: unknown }).errors)) {
        issues.push(`island "${name}" is not valid TSX: ${error instanceof Error ? error.message.split("\n")[0] : "syntax error"}`);
      } else {
        console.warn(`[vendo] island TSX validation unavailable on this runtime (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); islands ship unvalidated`);
        transform = undefined;
      }
    }
  }
  return { components, componentTools, issues };
};
