/**
 * `tsc` as the checks floor's static half — the NODE half.
 *
 * Given a screen file's text and the declarations {@link screenTypings}
 * derived from the catalog / Kit specs / tool shapes, this runs the real
 * TypeScript compiler over the pair in memory and translates its diagnostics
 * into the floor's findings. The compiler is the check: component names, prop
 * names, prop types, dotted data access and aggregate field names are all one
 * question — does this file type-check against the surface it is allowed to
 * name — and a compiler answers it better than a hand-rolled walker.
 *
 * WHAT IS LEFT HERE is exactly the part that needs a Node: finding the
 * compiler, and reading the lib files off disk. The program, the compiler host
 * and every sentence live in ./screen-program.ts, which imports no builtin and
 * therefore runs in a Worker too — see that file for why the boundary is a
 * module rather than a lazy import.
 *
 * DEGRADATION IS THE LAW. The compiler is resolved lazily through this
 * package's own dependency graph and feature-gated; when it cannot be loaded,
 * or loads but predates the API this module calls, the check returns NO
 * findings and never fails a build — the same posture as the smoke-render gate
 * ("Environment failures … skip the gate silently — the esbuild lazy-load
 * precedent", checking/smoke-render.ts:26-30) and as extraction's
 * "extraction never fails your build" floor (actions/sync/compiler-gate.ts).
 *
 * The lazy `createRequire` resolution is not a style choice: `typescript@` is
 * on the portability gate's FORBIDDEN_INPUTS (scripts/portability-gate.mjs),
 * and `@vendoai/apps` is reachable from the Worker server entry, so a static
 * `import ... from "typescript"` here would break `pnpm lint`. Layering
 * (apps → core only) is why this is not the loader in
 * `packages/actions/src/sync/common.ts:178-190`; that loader is the pattern
 * this one copies.
 */
import { createRequire } from "node:module";
import type TS from "typescript";
import {
  diagnosticLine,
  screenProgramWith,
  translateDiagnostic,
  type ScreenProgram,
  type ScreenTscInput,
} from "./screen-program.js";
import type { Finding } from "./types.js";

/** Every module-level compiler function this module calls, feature-detected
 *  one by one rather than by version string — the shape of the gate in
 *  `packages/actions/src/sync/compiler-gate.ts`, kept local because apps may
 *  not depend on actions. A compiler missing any of them degrades exactly like
 *  a compiler that failed to load. */
const REQUIRED_COMPILER_API = [
  "createProgram", "createSourceFile", "flattenDiagnosticMessageText", "forEachChild",
  "getDefaultLibFilePath", "isCallExpression", "isIdentifier", "isJsxAttribute",
  "isJsxAttributes", "isJsxExpression", "isJsxOpeningElement", "isJsxSelfClosingElement",
  "isPropertyAccessExpression",
] as const;

let compilerModule: typeof TS | null | undefined;

const usable = (candidate: unknown): boolean => {
  const ts = candidate as Record<string, unknown> | null | undefined;
  return ts !== null && ts !== undefined
    && REQUIRED_COMPILER_API.every((api) => typeof ts[api] === "function")
    && typeof (ts as { sys?: { readFile?: unknown } }).sys?.readFile === "function";
};

const loadCompiler = (): typeof TS | null => {
  if (compilerModule === undefined) {
    try {
      const candidate = createRequire(import.meta.url)("typescript") as typeof TS;
      compilerModule = usable(candidate) ? candidate : null;
    } catch {
      compilerModule = null;
    }
  }
  return compilerModule;
};

/** Test seam: the resolution is memoized for the process (a host's toolchain
 *  does not change mid-run), so the silent-degradation paths are unreachable
 *  from a test without one. Returns the restore. */
export function __setCompilerForTests(candidate: typeof TS | null): () => void {
  const previous = compilerModule;
  compilerModule = candidate === null ? null : (usable(candidate) ? candidate : null);
  return () => { compilerModule = previous; };
}

/** Build the program and collect its diagnostics, on this process's own
 *  compiler and Node's own disk. Never throws. */
export function screenProgram(input: ScreenTscInput): ScreenProgram {
  const ts = loadCompiler();
  if (ts === null) {
    return { ok: false, why: "no usable TypeScript compiler is reachable from @vendoai/apps" };
  }
  return screenProgramWith(
    ts,
    input,
    { read: (name) => ts.sys.readFile(name), exists: (name) => ts.sys.fileExists(name) },
    (options) => ts.getDefaultLibFilePath(options),
  );
}

/**
 * Type-check one screen against its generated declarations.
 *
 * Returns `[]` for a clean screen, `[]` when no usable compiler is available,
 * and never throws.
 */
export function screenTscFindings(input: ScreenTscInput): Finding[] {
  const program = screenProgram(input);
  // The compiler is the check, not the product: a compiler that would not load,
  // or that threw, degrades to no findings.
  if (!program.ok) return [];
  const { ts, file, checker, syntactic, semantic } = program;
  if (syntactic.length > 0) {
    // Report the break itself, once.
    const first = syntactic[0] as TS.Diagnostic;
    return [{
      severity: "block",
      where: `line ${diagnosticLine(file, first)}`,
      message: `does not parse as a screen: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
    }];
  }
  return semantic.flatMap((diagnostic) => translateDiagnostic(ts, file, checker, diagnostic));
}
