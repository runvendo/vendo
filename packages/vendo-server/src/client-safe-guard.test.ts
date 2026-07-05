/**
 * Client-safety guard for the subpath-exported modules, kept honest in CI
 * (same spirit as @vendoai/runtime's dependency-guard.test.ts).
 *
 * package.json exposes `./capabilities`, `./manifest-tools` and `./catalog`
 * as deep imports precisely so "use client" code (e.g. @vendoai/next/client)
 * can use them WITHOUT pulling the barrel — which imports node:fs and
 * node:crypto — into a browser bundle. Turbopack tolerates that; webpack/CRA
 * may not. So these three modules must stay free of runtime imports: no
 * node builtins, no server-only packages, no relative reach into siblings
 * that have them. Type-only imports (`import type` / `export type`) are
 * erased at compile time and are always fine.
 *
 * `model-choice.ts` isn't exported as a subpath itself, but `capabilities.ts`
 * imports it at runtime, so it must be just as pure — scanned here too.
 *
 * If this test failed: don't loosen it — move the runtime dependency out of
 * the client-safe module, or stop exporting that module as a subpath.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The modules package.json exports as client-safe subpaths, plus their pure helpers. */
const CLIENT_SAFE_MODULES = ["capabilities.ts", "manifest-tools.ts", "catalog.ts", "model-choice.ts"];

/** Relative runtime imports allowed between the client-safe modules only. */
const ALLOWED_RELATIVE = [
  "./capabilities.js",
  "./manifest-tools.js",
  "./catalog.js",
  "./model-choice.js",
];

/** Runtime import/export-from/side-effect specifiers (type-only ones erased). */
function runtimeSpecifiers(source: string): string[] {
  const statements = source.matchAll(
    /(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]*?from\s+)?["']([^"']+)["']/g,
  );
  return [...statements].filter(([, typeOnly]) => !typeOnly).map(([, , spec]) => spec!);
}

describe("client-safe guard: subpath modules stay browser-safe", () => {
  for (const file of CLIENT_SAFE_MODULES) {
    it(`${file} has no runtime imports of node:*, server packages, or unvetted siblings`, () => {
      const offending = runtimeSpecifiers(readFileSync(join(__dirname, file), "utf8")).filter(
        (spec) =>
          spec.startsWith("node:") ||
          spec === "ai" ||
          spec.startsWith("ai/") ||
          spec.startsWith("@ai-sdk/") ||
          spec.startsWith("@vendoai/runtime") ||
          (spec.startsWith(".") && !ALLOWED_RELATIVE.includes(spec)),
      );
      expect(offending).toEqual([]);
    });
  }
});
