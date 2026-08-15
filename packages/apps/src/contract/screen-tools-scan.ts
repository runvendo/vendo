/**
 * The `tools` literal-access scan a screen's source goes through
 * (`server/checking/component-screen.ts`), plus the specifier set a capture
 * walk may leave uncaptured because the render venue answers it itself
 * (`@vendoai/actions` sync/capture.ts).
 */
import { IN_CLIENT_ALLOWED_MODULES, IN_CLIENT_BUNDLED_PACKAGES } from "./inclient-modules.js";

/** Import specifiers the render venue resolves without a capture: react, the
 *  kit-ish names a model reaches for out of habit, and the packages the mount
 *  table bundles. */
const RESOLVABLE_SPECIFIERS = [
  ...IN_CLIENT_ALLOWED_MODULES,
  "@vendoai/ui",
  "@vendoai/ui/kit",
  "@vendoai/kit",
  "@vendoai/vendo",
  "@vendo/kit",
  "vendo/kit",
  ...IN_CLIENT_BUNDLED_PACKAGES,
] as const;

const RESOLVABLE_SPECIFIER_SET: ReadonlySet<string> = new Set(RESOLVABLE_SPECIFIERS);

/** A module specifier the render venue can resolve at runtime — the question a
 *  producer asks before shipping a captured closure. */
export const isIslandResolvableSpecifier = (specifier: string): boolean =>
  RESOLVABLE_SPECIFIER_SET.has(specifier);

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
