import type TS from "typescript";

/**
 * The shared capability gate for every host-resolved TypeScript compiler
 * (`loadCompiler` in common.ts, `loadTypescript` in static-ts.ts, the catalog
 * scan's dynamic import). Extraction's law is "extraction never fails your
 * build": a compiler that loads but predates the API surface extraction calls
 * must degrade exactly like a compiler that failed to load — analysis
 * resolves to nothing — never crash mid-scan (FINDINGS F1: a host pinning
 * typescript 4.7 died on `ts.getModifiers is not a function` during
 * `vendo init`).
 */

/** APIs extraction calls unconditionally. Every entry landed in TypeScript
 * 4.8, making 4.8 the effective floor — but the probe is on capabilities,
 * not version strings, so patched or forked compilers that carry the APIs
 * pass regardless of what their version claims. */
const REQUIRED_COMPILER_API = ["canHaveModifiers", "getModifiers"] as const;

/** Null when the candidate exposes every API extraction needs; otherwise the
 * candidate's version string, feeding the floor warning. */
export function unsupportedCompilerVersion(candidate: unknown): string | null {
  const ts = candidate as Partial<typeof TS> | null | undefined;
  if (REQUIRED_COMPILER_API.every((api) => typeof ts?.[api] === "function")) return null;
  return typeof ts?.version === "string" ? ts.version : "unknown";
}

/** Sticky for the process — a host's toolchain does not change mid-run, and
 * `loadCompiler` memoizes its (rejected) resolution anyway, so later syncs in
 * the same process could not re-detect the rejection themselves. */
let rejectedCompilerVersion: string | null = null;

/** Called by a loader whose every resolution candidate loaded but failed the
 * capability probe; sync surfaces the result once per report. */
export function noteRejectedCompiler(version: string): void {
  rejectedCompilerVersion = version;
}

/** The single host-facing warning for a loaded-but-too-old compiler, naming
 * the host's version and the floor. Null when no loader rejected one. */
export function compilerFloorWarning(): string | null {
  if (rejectedCompilerVersion === null) return null;
  return `host typescript ${rejectedCompilerVersion} is older than the >=4.8 floor extraction requires (missing ts.getModifiers); `
    + "compiler-based extraction (routes, trpc, graphql, server actions, component catalog) is disabled and resolves to nothing — "
    + "upgrade the host's typescript to >=4.8 to restore it";
}

/** Test seam: the rejection note is process-sticky by design. */
export function resetCompilerGateForTests(): void {
  rejectedCompilerVersion = null;
}
