/**
 * W4b — the island ambient contract (spec §format Islands).
 *
 * Island code gets React + hooks, the entire Kit, charts, and the `fmt`
 * helpers injected into the jail evaluation scope (react-live pattern), plus
 * an ambient `tools` API for direct host-tool calls. No imports: the KNOWN
 * specifiers below are silently stripped from island source (pretraining
 * habit), unknown specifiers stay compile errors routed to repair.
 *
 * This module is the SINGLE SOURCE OF TRUTH three enforcers share:
 * - the generation engine (`@vendoai/apps` engine.ts) strips known imports,
 *   scans `tools` usage, validates it against the live registry, and stamps
 *   the per-island tool manifest into the app document (`componentTools`);
 * - the jail runtime (`@vendoai/ui` runtime-entry.tsx) injects the ambient
 *   scope under exactly these names — a ui test pins the two lists together;
 * - the jail HOST bridge (`@vendoai/ui` JailedComponent.tsx) exposes ONLY the
 *   manifest's tools through the postMessage seam (never trusting the iframe),
 *   using {@link resolveIslandToolName} / {@link islandToolFallbackManifest}.
 */
import { JAIL_ALLOWED_MODULES } from "./jail-modules.js";

/** React values ambient in every island (the names pretraining reaches for). */
export const ISLAND_AMBIENT_REACT_NAMES = [
  "React",
  "ReactDOM",
  "Fragment",
  "useState",
  "useEffect",
  "useMemo",
  "useCallback",
  "useRef",
  "useReducer",
  "useId",
  "useLayoutEffect",
  "useTransition",
  "useDeferredValue",
  "useSyncExternalStore",
] as const;

/** The Kit components ambient in every island. Pinned to the ui Kit registry
 *  by a test in @vendoai/ui (core cannot import ui — layering). */
export const ISLAND_AMBIENT_KIT_NAMES = [
  "Stack", "Row", "Grid", "Surface", "Divider",
  "Text", "Money", "DateTime", "Percent", "Num", "EnumBadge",
  "DataTable", "CardList", "Stat", "Badge",
  "LineChart", "BarChart", "DonutChart", "Sparkline", "Progress",
  "Input", "Select", "DatePicker", "Textarea", "Checkbox", "Button", "Form", "Disclaimer",
  "Tabs", "Callout", "Accordion",
] as const;

/** `fmt` (Kit semantics formatters) and `tools` (the guarded host-tool pipe). */
export const ISLAND_AMBIENT_HELPER_NAMES = ["fmt", "tools"] as const;

/** Every name the jail evaluation scope provides to island code. */
export const ISLAND_AMBIENT_NAMES: readonly string[] = [
  ...ISLAND_AMBIENT_REACT_NAMES,
  ...ISLAND_AMBIENT_KIT_NAMES,
  ...ISLAND_AMBIENT_HELPER_NAMES,
];

/** Import specifiers the ambient scope already covers: react and the kit-ish
 *  names models emit out of habit. Static imports of these are silently
 *  stripped by the engine AND resolvable inside the jail (runtime-entry maps
 *  them onto the bundled scope), so a not-yet-stripped streaming partial still
 *  renders. Anything else is a compile error → repair. */
export const ISLAND_STRIPPED_SPECIFIERS = [
  ...JAIL_ALLOWED_MODULES,
  "@vendoai/ui",
  "@vendoai/ui/kit",
  "@vendoai/kit",
  "@vendoai/vendo",
  "@vendo/kit",
  "vendo/kit",
] as const;

/** A module specifier the jail runtime can resolve for island code — the
 *  react table plus the kit-ish names mapped onto the bundled ambient scope
 *  (so a not-yet-stripped streaming partial renders). */
export type IslandResolvableModule = (typeof ISLAND_STRIPPED_SPECIFIERS)[number];

const STRIPPED_SPECIFIER_SET: ReadonlySet<string> = new Set(ISLAND_STRIPPED_SPECIFIERS);
const AMBIENT_NAME_SET: ReadonlySet<string> = new Set(ISLAND_AMBIENT_NAMES);

/** A module specifier the ambient island scope already provides. */
export const isStrippedIslandSpecifier = (specifier: string): boolean =>
  STRIPPED_SPECIFIER_SET.has(specifier);

export interface IslandImportStrip {
  /** The source with every known static import removed. */
  source: string;
  /** Locals a stripped import bound that the ambient scope does NOT provide
   *  (aliases, unexpected default names) — routed to repair, never silently
   *  left to a runtime ReferenceError. */
  issues: string[];
}

// One STATIC import statement: `import <clause> from "spec"` or the
// side-effect form `import "spec"`. Deliberately does not match dynamic
// import calls or CommonJS require calls — those stay byte-for-byte for the
// engine's import gate to reject.
const STATIC_IMPORT_PATTERN =
  /\bimport\s+(?:(type\s+)?([\w$]+(?:\s*,\s*\{[^}]*\})?|\{[^}]*\}|\*\s+as\s+[\w$]+)\s+from\s+)?["']([^"']+)["']\s*;?/g;

/** The local names an import clause binds (default, namespace, named+aliases). */
const clauseLocalNames = (clause: string): string[] => {
  const names: string[] = [];
  const braceStart = clause.indexOf("{");
  const head = (braceStart === -1 ? clause : clause.slice(0, braceStart)).trim();
  const namespace = /^\*\s+as\s+([\w$]+)/.exec(head);
  if (namespace !== null) names.push(namespace[1] as string);
  else if (head !== "") names.push(head.replace(/,\s*$/, "").trim());
  if (braceStart !== -1) {
    const inner = clause.slice(braceStart + 1, clause.lastIndexOf("}"));
    for (const entry of inner.split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "" || trimmed.startsWith("type ")) continue;
      const alias = /\s+as\s+([\w$]+)$/.exec(trimmed);
      names.push(alias === null ? trimmed : (alias[1] as string));
    }
  }
  return names.filter((name) => name !== "");
};

/** Silently strip static imports of {@link ISLAND_STRIPPED_SPECIFIERS};
 *  every other import form/specifier is left byte-for-byte for the gate. */
export function stripIslandImports(source: string): IslandImportStrip {
  const issues: string[] = [];
  const stripped = source.replace(
    STATIC_IMPORT_PATTERN,
    (statement, typeOnly: string | undefined, clause: string | undefined, specifier: string) => {
      if (!STRIPPED_SPECIFIER_SET.has(specifier)) return statement;
      if (clause !== undefined && typeOnly === undefined) {
        for (const local of clauseLocalNames(clause)) {
          if (!AMBIENT_NAME_SET.has(local)) {
            issues.push(
              `imports "${local}" from "${specifier}" — islands have NO imports; the ambient scope provides these names directly (React, the hooks, the Kit components, fmt, tools). Use the ambient name instead of an alias.`,
            );
          }
        }
      }
      return "";
    },
  );
  return { source: stripped, issues };
}

export interface IslandToolScan {
  /** Every literal `tools.a.b` member chain, in source order, deduplicated. */
  paths: string[][];
  /** Literal-member-access-only violations (computed access, aliasing). */
  violations: string[];
}

/** Blank string literals, template literals (keeping `${…}` code), and
 *  comments so the tools scan never fires on prose. Offsets are preserved. */
const blankNonCode = (source: string): string => {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let position = from; position < to; position += 1) {
      if (out[position] !== "\n") out[position] = " ";
    }
  };
  // Consume a template-literal text chunk starting at `from` (just past the
  // opening backtick or a closing `}`), blanking it. Returns the next scan
  // position and whether an interpolation opened (scan resumes as code).
  const consumeTemplateText = (from: number): { next: number; interpolated: boolean } => {
    let index = from;
    while (index < source.length) {
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === "`") {
        blank(from, index + 1);
        return { next: index + 1, interpolated: false };
      }
      if (source[index] === "$" && source[index + 1] === "{") {
        blank(from, index + 2);
        return { next: index + 2, interpolated: true };
      }
      index += 1;
    }
    blank(from, source.length);
    return { next: source.length, interpolated: false };
  };
  // Brace depths saved per open interpolation, so `}` closing an inner object
  // is distinguished from the `}` that resumes the surrounding template.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (char === '"' || char === "'") {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== char && source[index] !== "\n") {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index = Math.min(index + 1, source.length);
      blank(start, index);
    } else if (char === "`") {
      blank(index, index + 1);
      const chunk = consumeTemplateText(index + 1);
      if (chunk.interpolated) {
        templateStack.push(braceDepth);
        braceDepth = 0;
      }
      index = chunk.next;
    } else if (char === "{") {
      braceDepth += 1;
      index += 1;
    } else if (char === "}") {
      if (braceDepth === 0 && templateStack.length > 0) {
        // The interpolation closed — back inside the template's text.
        braceDepth = templateStack.pop() as number;
        blank(index, index + 1);
        const chunk = consumeTemplateText(index + 1);
        if (chunk.interpolated) {
          templateStack.push(braceDepth);
          braceDepth = 0;
        }
        index = chunk.next;
      } else {
        braceDepth = Math.max(0, braceDepth - 1);
        index += 1;
      }
    } else {
      index += 1;
    }
  }
  return out.join("");
};

const MEMBER_CHAIN = /^(?:\s*\??\.\s*[A-Za-z_$][\w$]*)+/;
// Expression context to the LEFT of a bare `tools` — assignment, call
// argument, array/object member, return/arrow. JSX text ("my tools here")
// has an identifier or tag character there instead, so prose never trips it.
const ALIAS_CONTEXT = /(?:[=(,:[{]|\breturn|=>)\s*$/;

/** Scan island source for ambient `tools` usage. Literal member access only:
 *  computed access and aliasing are violations (TASK §2); chains are returned
 *  for manifest inference. */
export function scanIslandTools(source: string): IslandToolScan {
  const code = blankNonCode(source);
  const paths: string[][] = [];
  const seen = new Set<string>();
  const violations: string[] = [];
  const identifier = /\btools\b/g;
  for (let match = identifier.exec(code); match !== null; match = identifier.exec(code)) {
    const before = code[match.index - 1];
    if (before !== undefined && /[.\w$]/.test(before)) continue; // `powertools` / `a.tools`
    const rest = code.slice(match.index + match[0].length);
    const chain = MEMBER_CHAIN.exec(rest);
    if (chain !== null) {
      const afterChain = rest.slice(chain[0].length).trimStart();
      if (afterChain.startsWith("[")) {
        violations.push(
          "uses computed member access on `tools` — literal member access only: call `tools.tool_name(args)` with the tool name written out",
        );
        continue;
      }
      const path = (chain[0].match(/[A-Za-z_$][\w$]*/g) ?? []) as string[];
      const key = path.join(".");
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(path);
      }
      continue;
    }
    const after = rest.trimStart();
    if (after.startsWith("[")) {
      violations.push(
        "uses computed member access on `tools` — literal member access only: call `tools.tool_name(args)` with the tool name written out",
      );
      continue;
    }
    if (ALIAS_CONTEXT.test(code.slice(0, match.index))) {
      violations.push(
        "aliases or passes the `tools` object around — literal member access only: call `tools.tool_name(args)` directly where you need it",
      );
    }
  }
  return { paths, violations };
}

/** Resolve one literal member chain to a registry tool name. Tool names never
 *  contain dots (TOOL_NAME_PATTERN), so `tools.clients.search` names the tool
 *  `clients_search` and `tools.list_invoices` names it directly. */
export function resolveIslandToolName(
  path: readonly string[],
  known: ReadonlySet<string>,
): string | null {
  const joined = path.join("_");
  return known.has(joined) ? joined : null;
}

/** The manifest a HOST derives from island source when the document carries no
 *  stamped `componentTools` (legacy documents, mid-stream partials). Purely a
 *  function of the source the host itself holds — never the iframe's claim. */
export function islandToolFallbackManifest(source: string): string[] {
  return [...new Set(scanIslandTools(source).paths.map((path) => path.join("_")))];
}
