import { describe, expect, it } from "vitest";
import {
  JAIL_BUNDLED_PACKAGES,
  ISLAND_RESOLVABLE_SPECIFIERS,
} from "@vendoai/apps/contract";
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

  it("is not a thenable, so awaiting anything the shim answered resolves", async () => {
    // Every unknown property chains, and `then` is a property. A schema (or
    // the module itself) that answers `then` with another callable node is a
    // thenable whose `then` never calls back: `await` on it hangs the island
    // forever, which is the one outcome this shim is written to avoid.
    const schema = z.object({ a: z.string() });
    expect(await Promise.resolve(schema)).toBe(schema);
    expect(await Promise.resolve(zodShim)).toBe(zodShim);
    expect((schema as Record<string, unknown>).then).toBeUndefined();
    expect("then" in (schema as object)).toBe(false);
    expect("then" in zodShim).toBe(false);
  });

  it("keeps `catch` — the one promise-shaped name zod actually owns", () => {
    // `then` is the WHOLE thenable protocol, so blanking any further name buys
    // nothing and costs a real method: `.catch(fallback)` is zod's fallback
    // declaration on every schema (zod 3 and 4) and a namespace helper in zod 4.
    // `finally` is neither, so nothing else in this family needs blanking.
    expect(typeof (z.number() as unknown as Record<string, unknown>).catch).toBe("function");
    expect(() => z.number().catch(3)).not.toThrow();
    expect(() => z.object({ n: z.number().catch(3).optional() })).not.toThrow();
    expect(typeof (zodShim as Record<string, unknown>).catch).toBe("function");
    expect("catch" in zodShim).toBe(true);
    expect("finally" in zodShim).toBe(true);
  });

  it("a caught schema still REFUSES to validate — a fallback is not a validator", () => {
    // `.catch(3)` declares what zod would return for bad input; the shim cannot
    // tell good input from bad, so guessing the fallback would be exactly the
    // silent mis-validation this shim exists to never do.
    const schema = z.number().catch(3) as unknown as Record<string, () => unknown>;
    expect(() => schema.parse!()).toThrow(/not available in the Vendo preview sandbox/);
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
