import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_SERVER_MODULES, analyzeClosure } from "../../../src/cli/playground/closure-guard.js";

// The client-only invariant (HANDOFF oss-export, Task 2): the `@vendoai/vendo/
// try-surface` entry's import closure must contain ONLY @vendoai/ui,
// @vendoai/core, react, ai, and the app's own files — NEVER the umbrella server
// graph (@vendoai/store, @vendoai/actions, ./server,
// createVendo). This guard walks the SOURCE value-import closure and fails if a
// server module ever enters it, so vendo-web can compile the entry as a client
// route. The fixtures prove it catches a regression, transitively, without
// false-positiving on erased type-only imports.

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../src/cli/playground/__fixtures__/${name}`, import.meta.url));

describe("closure guard — analyzeClosure", () => {
  it("passes a clean entry (only react + a local module in the closure)", () => {
    const result = analyzeClosure(fixture("clean/entry.ts"));
    expect(result.forbidden).toEqual([]);
    expect(result.bareSpecifiers).toContain("react");
  });

  it("catches a server-graph import buried transitively in the closure", () => {
    const result = analyzeClosure(fixture("dirty/entry.ts"));
    // entry.ts imports mid.ts, which value-imports @vendoai/store.
    expect(result.forbidden.length).toBeGreaterThan(0);
    expect(result.forbidden.join("\n")).toContain("@vendoai/store");
  });

  it("does NOT flag a type-only server-graph import (erased at build)", () => {
    const result = analyzeClosure(fixture("typeonly/entry.ts"));
    expect(result.forbidden).toEqual([]);
  });

  it("exposes the forbidden module list it enforces", () => {
    expect(FORBIDDEN_SERVER_MODULES).toContain("@vendoai/store");
    expect(FORBIDDEN_SERVER_MODULES).toContain("@vendoai/actions");
  });
});

describe("the real @vendoai/vendo/try-surface entry is client-only", () => {
  const entry = fileURLToPath(new URL("../../../src/try-surface.ts", import.meta.url));

  it("has NO server-graph module anywhere in its import closure", () => {
    const result = analyzeClosure(entry);
    expect(result.forbidden, result.forbidden.join("\n")).toEqual([]);
  });

  it("reaches only client-safe bare modules (ui/core/react/ai)", () => {
    const result = analyzeClosure(entry);
    const allowedPrefixes = ["@vendoai/ui", "@vendoai/core", "react", "react-dom", "ai", "zod"];
    const strays = result.bareSpecifiers.filter(
      (spec) => !allowedPrefixes.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`)),
    );
    expect(strays, `unexpected bare imports: ${strays.join(", ")}`).toEqual([]);
  });
});
