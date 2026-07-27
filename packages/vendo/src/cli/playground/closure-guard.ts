/**
 * Client-only closure guard for the `@vendoai/vendo/try-surface` entry.
 *
 * The try surface must compile as a vendo-web CLIENT route, so its transitive
 * import closure may contain ONLY @vendoai/ui, @vendoai/core, react, ai, and the
 * app's own files — NEVER the umbrella server graph. This walks the SOURCE
 * value-import closure (following relative imports within the package, recording
 * bare specifiers) and reports any server module it reaches.
 *
 * Why a source walk rather than a bundler metafile: it is hermetic (reads only
 * this package's `src/`, no built deps, no node_modules resolution), and the
 * regression it must catch — a server import added to a closure file, directly
 * or transitively — always appears as a value import in some source file on the
 * path. `import type` is skipped because TypeScript erases it, so it never
 * enters the runtime closure the client route actually bundles.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The umbrella server-graph packages the client surface must never pull in. */
export const FORBIDDEN_SERVER_MODULES = ["@vendoai/store", "@vendoai/actions", "@vendoai/agent"] as const;

/** Relative-import targets that are the umbrella's own server entry points
 *  (they export `createVendo` and the server composition). */
const FORBIDDEN_SOURCE_BASENAMES = ["server", "index"];

export interface ClosureResult {
  /** Absolute paths of every source file reached through value imports. */
  files: string[];
  /** Every bare (non-relative) module specifier reached. */
  bareSpecifiers: string[];
  /** Human-readable violations; empty means the closure is clean. */
  forbidden: string[];
}

interface ImportRef {
  /** The module specifier. */
  specifier: string;
  /** The bindings named on the statement (for `createVendo` detection). */
  named: string[];
}

/** Strip block and line comments so import-shaped text inside them is ignored. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Extract the value (non-type) imports/re-exports and dynamic imports. */
function valueImports(source: string): ImportRef[] {
  const code = stripComments(source);
  const refs: ImportRef[] = [];

  // `import ... from "x"` and `export ... from "x"` (skip `import type` / `export type`).
  const staticRe = /(?:^|[\s;])(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  for (let m = staticRe.exec(code); m !== null; m = staticRe.exec(code)) {
    const clause = m[2]!.trim();
    if (clause.startsWith("type ") || clause.startsWith("type{") || clause === "type") continue;
    refs.push({ specifier: m[3]!, named: namedBindings(clause) });
  }

  // Side-effect imports: `import "x";`.
  const sideEffectRe = /(?:^|[\s;])import\s*["']([^"']+)["']/g;
  for (let m = sideEffectRe.exec(code); m !== null; m = sideEffectRe.exec(code)) {
    refs.push({ specifier: m[1]!, named: [] });
  }

  // Dynamic imports: `import("x")`.
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = dynamicRe.exec(code); m !== null; m = dynamicRe.exec(code)) {
    refs.push({ specifier: m[1]!, named: [] });
  }

  return refs;
}

/** Best-effort list of named bindings inside an import clause's `{ ... }`. */
function namedBindings(clause: string): string[] {
  const brace = clause.match(/\{([\s\S]*)\}/);
  if (!brace) return [];
  return brace[1]!
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
    .filter(Boolean);
}

/** Resolve a relative `./x.js`-style specifier to an existing source file. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isForbiddenBare(specifier: string): boolean {
  return FORBIDDEN_SERVER_MODULES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

/** Walk the value-import closure of `entryPath` and report server-graph leaks. */
export function analyzeClosure(entryPath: string): ClosureResult {
  const entry = resolve(entryPath);
  const visited = new Set<string>();
  const bare = new Set<string>();
  const forbidden: string[] = [];
  const stack = [entry];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);

    for (const ref of valueImports(readFileSync(file, "utf8"))) {
      const { specifier, named } = ref;

      if (named.includes("createVendo")) {
        forbidden.push(`${relative(entry, file)} imports createVendo from "${specifier}"`);
      }

      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        if (!resolved) continue;
        const stem = resolved.replace(/\.(ts|tsx)$/, "");
        if (FORBIDDEN_SOURCE_BASENAMES.some((name) => stem.endsWith(`/${name}`) && isPackageRoot(resolved))) {
          forbidden.push(`${relative(entry, file)} imports the umbrella server graph ("${specifier}")`);
          continue; // don't descend into the server graph
        }
        stack.push(resolved);
        continue;
      }

      bare.add(specifier);
      if (isForbiddenBare(specifier)) {
        forbidden.push(`${relative(entry, file)} imports "${specifier}"`);
      }
    }
  }

  return { files: [...visited], bareSpecifiers: [...bare].sort(), forbidden };
}

/** A resolved file is a server root only if it sits at the package src root
 *  (…/packages/vendo/src/server.ts), not a nested `server.ts` helper. */
function isPackageRoot(resolved: string): boolean {
  return /\/src\/(server|index)\.tsx?$/.test(resolved);
}

function relative(from: string, file: string): string {
  const marker = "/src/";
  const idx = file.indexOf(marker);
  return idx === -1 ? file : file.slice(idx + 1);
}
