import { describe, expect, it } from "vitest";

/** The failure classes the island validation catch must separate (field case
 *  2026-07: an inlined esbuild dying on __filename in workerd was misread as
 *  "invalid TSX" for EVERY island, failing every app build on Workers). The
 *  discriminator is esbuild's TransformError shape: a real syntax verdict
 *  carries an `errors` array; a broken validator throws anything else. */
const isSyntaxVerdict = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Array.isArray((error as { errors?: unknown }).errors);

describe("island validator error classification", () => {
  it("an esbuild TransformError (errors array) is a syntax verdict", () => {
    const transformError = Object.assign(new Error("Expected \")\" but found \"}\""), { errors: [{}] });
    expect(isSyntaxVerdict(transformError)).toBe(true);
  });

  it("a runtime crash of the validator itself is NOT a syntax verdict", () => {
    expect(isSyntaxVerdict(new ReferenceError("__filename is not defined"))).toBe(false);
    expect(isSyntaxVerdict(new Error("spawnSync esbuild ENOENT"))).toBe(false);
  });
});
