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

/** Every name the jail evaluation scope provides to island code. The literal
 *  tuple type is load-bearing: the jail runtime's scope record is typed
 *  `Record<IslandAmbientName, unknown>`, so adding a name here without
 *  providing it there is a compile error (review: a `readonly string[]`
 *  annotation would collapse that check to `Record<string, …>`). */
export const ISLAND_AMBIENT_NAMES = [
  ...ISLAND_AMBIENT_REACT_NAMES,
  ...ISLAND_AMBIENT_KIT_NAMES,
  ...ISLAND_AMBIENT_HELPER_NAMES,
] as const;

/** One name the ambient island scope provides. */
export type IslandAmbientName = (typeof ISLAND_AMBIENT_NAMES)[number];

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
 *  every other import form/specifier is left byte-for-byte for the gate.
 *  Matching runs against the non-code-blanked view (offsets preserved), so
 *  import-LIKE text inside strings or comments is never corrupted — a real
 *  import is code and reads identically in both views. */
export function stripIslandImports(source: string): IslandImportStrip {
  const issues: string[] = [];
  const blanked = blankNonCode(source);
  const spans: Array<{ start: number; end: number }> = [];
  for (const blankedMatch of blanked.matchAll(STATIC_IMPORT_PATTERN)) {
    // The blanked view locates real (code) imports; the groups are read from
    // the ORIGINAL at the same offsets, since the specifier's contents are
    // blanked in the located view.
    const match = new RegExp(STATIC_IMPORT_PATTERN.source).exec(
      source.slice(blankedMatch.index, blankedMatch.index + blankedMatch[0].length),
    );
    if (match === null) continue;
    const statement = match[0];
    const typeOnly = match[1];
    const clause = match[2];
    const specifier = match[3];
    if (specifier === undefined || !STRIPPED_SPECIFIER_SET.has(specifier)) continue;
    if (clause !== undefined && typeOnly === undefined) {
      for (const local of clauseLocalNames(clause)) {
        if (!AMBIENT_NAME_SET.has(local)) {
          issues.push(
            `imports "${local}" from "${specifier}" — islands have NO imports; the ambient scope provides these names directly (React, the hooks, the Kit components, fmt, tools). Use the ambient name instead of an alias.`,
          );
        }
      }
    }
    spans.push({ start: blankedMatch.index, end: blankedMatch.index + statement.length });
  }
  if (spans.length === 0) return { source, issues };
  let stripped = "";
  let cursor = 0;
  for (const span of spans) {
    stripped += source.slice(cursor, span.start);
    cursor = span.end;
  }
  stripped += source.slice(cursor);
  return { source: stripped, issues };
}

export interface IslandToolScan {
  /** Every literal `tools.a.b` member chain, in source order, deduplicated. */
  paths: string[][];
  /** Literal-member-access-only violations (computed access, aliasing). */
  violations: string[];
}

/** Blank string literals, template literals (keeping `${…}` code), and
 *  comments so the tools scan never fires on prose. Offsets are preserved.
 *  Exported for the island source scanners that share this code-only view
 *  (island-derived-values.ts); not part of the public contract surface. */
export const blankNonCode = (source: string): string => {
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
        // Keep the closing backtick visible: delimiters are code-shaped and
        // the offset-consumers (import strip, action-name scan) need them.
        blank(from, index);
        return { next: index + 1, interpolated: false };
      }
      if (source[index] === "$" && source[index + 1] === "{") {
        blank(from, index);
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
      const closedOnQuote = source[index] === char;
      index = Math.min(index + 1, source.length);
      // Blank the CONTENTS, keep the delimiters (offset consumers need them).
      blank(start + 1, closedOnQuote ? index - 1 : index);
    } else if (char === "`") {
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

// `[` or the optional-chained `?.[` — the same computed access (review).
const startsComputedAccess = (text: string): boolean =>
  text.startsWith("[") || /^\?\.\s*\[/.test(text);

/** Scan island source for ambient `tools` usage. Literal member access only:
 *  computed access and aliasing are violations (TASK §2); CALLED chains are
 *  returned for manifest inference. An un-called chain in prose (JSX text like
 *  "great tools.Buy now") is ignored; an un-called chain being assigned or
 *  passed around is the aliasing violation. */
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
      if (startsComputedAccess(afterChain)) {
        violations.push(
          "uses computed member access on `tools` — literal member access only: call `tools.tool_name(args)` with the tool name written out",
        );
        continue;
      }
      if (afterChain.startsWith("(")) {
        // A CALL — the only form that reaches a tool at runtime.
        const path = (chain[0].match(/[A-Za-z_$][\w$]*/g) ?? []) as string[];
        const key = path.join(".");
        if (!seen.has(key)) {
          seen.add(key);
          paths.push(path);
        }
        continue;
      }
      // Un-called chain: aliasing when it sits in expression position;
      // otherwise prose (JSX text) — ignore.
      if (ALIAS_CONTEXT.test(code.slice(0, match.index))) {
        violations.push(
          "aliases or passes the `tools` object around — literal member access only: call `tools.tool_name(args)` directly where you need it",
        );
      }
      continue;
    }
    const after = rest.trimStart();
    if (startsComputedAccess(after)) {
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

/** Literal legacy `vendo.action("tool_name", …)` names in island CODE (never
 *  strings/comments) — the legacy action channel's own least-privilege set. */
export function islandVendoActionNames(source: string): string[] {
  const code = blankNonCode(source);
  const names: string[] = [];
  // The blanking erases the quoted name too, so read it from the ORIGINAL at
  // the blanked match's offsets (blankNonCode preserves offsets).
  const pattern = /\bvendo\s*\.\s*action\s*\(\s*(["'`])/g;
  for (const match of code.matchAll(pattern)) {
    const quote = match[1] as string;
    const start = match.index + match[0].length;
    const end = source.indexOf(quote, start);
    if (end > start) names.push(source.slice(start, end));
  }
  return [...new Set(names)];
}

// The jail's CSP is connect-src 'none': these APIs silently die inside an
// island (live P3 finding: a habit-written fetch("/api/…") was blocked and the
// island just rendered nothing). Caught at compile → repair to ambient tools.
const NETWORK_API_PATTERN =
  /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\b/g;

/** The network API names an island source reaches for — always a defect: the
 *  jail has no network, and the ambient tools API is the only channel. */
export function islandNetworkViolations(source: string): string[] {
  const code = blankNonCode(source);
  const found = new Set<string>();
  for (const match of code.matchAll(NETWORK_API_PATTERN)) {
    found.add((match[1] ?? match[2]) as string);
  }
  return [...found];
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
