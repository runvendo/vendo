import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// HANDOFF oss-export: `@vendoai/vendo/try-surface` is the importable client-only
// entry both venues build from. Like try-export.test.ts, the runtime half checks
// the SOURCE entry (deterministic against the working tree); the exports-map half
// pins the dist mapping the published subpath resolves through — the same shape
// every other subpath (./server, ./try, ...) uses.

const require = createRequire(import.meta.url);

/** The public shape the CLI IIFE and a vendo-web Next route both consume. */
const TRY_SURFACE_EXPORTS = ["mount", "PlaygroundApp", "TrySurface", "mountScenario", "mountLauncher"] as const;

describe("@vendoai/vendo/try-surface — the importable client surface", () => {
  it("exports the mount fn, the React components, and the embed drop-ins", async () => {
    const entry = await import("../src/try-surface.js");
    for (const name of TRY_SURFACE_EXPORTS) {
      expect(entry[name as keyof typeof entry], name).toBeTypeOf("function");
    }
  });

  it("maps the ./try-surface subpath to dist in the exports map (same shape as ./try)", () => {
    const pkg = require("../package.json") as { exports: Record<string, unknown> };
    expect(pkg.exports["./try-surface"]).toEqual({
      types: "./dist/try-surface.d.ts",
      default: "./dist/try-surface.js",
    });
  });
});
