import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Unified try surface (Task 15a): the hosted try venue (a Cloudflare Worker in
// the console repo) composes createVendo per anonymous session from in-memory
// artifacts and needs the synthetic fetch + the try artifact schemas as PUBLIC
// package exports. Like type-surface.test.ts, the runtime half checks the
// SOURCE entry (deterministic against the working tree); the exports-map half
// pins the dist mapping the published subpath resolves through — the same
// shape every other subpath (./server, ./extract, ...) uses.

const require = createRequire(import.meta.url);

/** Every export Task 15a promises the hosted venue. */
const TRY_SURFACE_EXPORTS = [
  "createSyntheticFetch",
  "usecasesFileSchema",
  "fixturesFileSchema",
  "tryProfileSchema",
  "assembleTryProfile",
  "VENDO_USECASES_FORMAT",
  "VENDO_FIXTURES_FORMAT",
] as const;

describe("@vendoai/vendo/try — the hosted try venue's public surface", () => {
  it("the try entry exports the synthetic fetch, the artifact schemas, and the format constants", async () => {
    const entry = await import("../src/try.js");
    for (const name of TRY_SURFACE_EXPORTS) {
      expect(entry[name as keyof typeof entry], name).toBeDefined();
    }
    expect(entry.VENDO_USECASES_FORMAT).toBe("vendo/usecases@1");
    expect(entry.VENDO_FIXTURES_FORMAT).toBe("vendo/fixtures@1");
  });

  it("maps the ./try subpath to dist in the exports map (same shape as ./server)", () => {
    const pkg = require("../package.json") as { exports: Record<string, unknown> };
    expect(pkg.exports["./try"]).toEqual({
      types: "./dist/try.d.ts",
      default: "./dist/try.js",
    });
  });
});
