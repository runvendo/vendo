import { describe, expect, it } from "vitest";
import { JAIL_BUNDLED_PACKAGES, ISLAND_RESOLVABLE_SPECIFIERS } from "@vendoai/core";
import { zodShim } from "../../src/tree/jail/zod-shim.js";

/** The `z` namespace as jail code receives it. */
const z = (zodShim as { z: Record<string, (...args: unknown[]) => Record<string, unknown>> }).z;

describe("the jail's zod shim", () => {
  it("resolves the declaration surface real host registries use", () => {
    // Measured against this repo's captures: z.object/string/number/boolean/
    // enum plus .optional() and .describe() is the whole surface touched.
    expect(() => {
      z.object({
        text: z.string().optional(),
        value: z.number().describe("Amount in integer cents"),
        variant: z.enum(["ok", "warn"]).optional(),
        dot: z.boolean().optional(),
        rows: z.array(z.object({ label: z.string() })).min(1),
      });
    }).not.toThrow();
  });

  it("chains through a builder it has never heard of rather than crashing", () => {
    // A registry using a zod constructor we did not enumerate must still LOAD —
    // the whole point is letting the component render.
    expect(() => z.discriminatedUnion("kind", []).brand().readonly()).not.toThrow();
  });

  it("REFUSES to validate, loudly, instead of returning a plausible wrong value", () => {
    // The one thing a shim must never fake. A silent mis-validation inside a
    // host's own page would be far worse than the bytes it saves.
    for (const method of ["parse", "safeParse", "parseAsync", "safeParseAsync"] as const) {
      const schema = z.object({ a: z.string() }) as Record<string, () => unknown>;
      expect(() => schema[method]!(), method).toThrow(/not available in the Vendo preview sandbox/);
    }
    expect(() => (z as unknown as Record<string, () => unknown>).parse!()).toThrow(/preview sandbox/);
  });

  it("is registered as a bundled package, so producers and the runtime agree", () => {
    // Permit-without-provide is the bug this pairing prevents: the runtime
    // table is typed on the same list capture checks.
    expect(JAIL_BUNDLED_PACKAGES).toContain("zod");
    for (const specifier of JAIL_BUNDLED_PACKAGES) {
      expect(ISLAND_RESOLVABLE_SPECIFIERS).toContain(specifier);
    }
  });
});
