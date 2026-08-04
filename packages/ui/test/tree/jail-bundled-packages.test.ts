import { describe, expect, it } from "vitest";
import { transform } from "sucrase";
import { clsx } from "clsx";
import * as tailwindMerge from "tailwind-merge";
import { JAIL_BUNDLED_PACKAGES } from "@vendoai/core";
import { zodShim, JailZodShimError } from "../../src/tree/jail/zod-shim.js";

/**
 * PERMITTED IS NOT USABLE. The jail compiles with sucrase's `imports` transform,
 * so `import x from "pkg"` becomes `_interopRequireDefault(require("pkg"))`,
 * which double-wraps any entry lacking `__esModule: true` — the default import
 * then binds the module object instead of the export and calling it throws.
 * Our demos happen to reach clsx through a NAMED import, so they never caught
 * it. These tests assert every style a real host writes, per package.
 */

/** The jail's module table, mirrored (runtime-entry.tsx JAIL_MODULES). */
const TABLE: Record<string, unknown> = {
  clsx: { __esModule: true, clsx, default: clsx },
  "tailwind-merge": { __esModule: true, ...tailwindMerge, default: tailwindMerge },
  zod: zodShim,
};

/** Compile and evaluate one module exactly as the jail loader does. */
function evaluate(source: string): Record<string, unknown> {
  const code = transform(source, { transforms: ["typescript", "jsx", "imports"], production: true }).code;
  const record = { exports: {} as Record<string, unknown> };
  const localRequire = (specifier: string): unknown => {
    if (!Object.prototype.hasOwnProperty.call(TABLE, specifier)) {
      throw new Error(`module "${specifier}" is not available in the Vendo jail`);
    }
    return TABLE[specifier];
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function("require", "module", "exports", code)(localRequire, record, record.exports);
  return record.exports;
}

describe("the jail's bundled packages, through every import style", () => {
  it("clsx: default, named, and aliased-default all call", () => {
    expect(evaluate(`import clsx from "clsx"; export const r = clsx("a", "b");`).r).toBe("a b");
    expect(evaluate(`import { clsx } from "clsx"; export const r = clsx("a", "b");`).r).toBe("a b");
    // `import cn from "clsx"` — the shadcn habit.
    expect(evaluate(`import cn from "clsx"; export const r = cn("a", { b: true });`).r).toBe("a b");
  });

  it("tailwind-merge: default and named both merge for real", () => {
    // Real behaviour, not a shim: the later conflicting class must WIN.
    expect(evaluate(`import { twMerge } from "tailwind-merge"; export const r = twMerge("px-2 px-4");`).r).toBe("px-4");
    expect(evaluate(`import twm from "tailwind-merge"; export const r = twm.twMerge("px-2 px-4");`).r).toBe("px-4");
  });

  it("zod: named, namespace, and default all resolve the declaration surface", () => {
    // `import { z }` is Zod 3's documented style; `import * as z` is Zod 4's.
    expect(evaluate(`import { z } from "zod"; export const r = typeof z.object({ a: z.string() });`).r).toBe("function");
    expect(evaluate(`import * as z from "zod"; export const r = typeof z.object({ a: z.string() });`).r).toBe("function");
    expect(evaluate(`import z from "zod"; export const r = typeof z.object({ a: z.string() });`).r).toBe("function");
  });

  it("zod: a real registry declaration evaluates at module scope", () => {
    const exports = evaluate(`
      import { z } from "zod";
      export const props = z.object({
        value: z.number().describe("cents"),
        variant: z.enum(["ok", "warn"]).optional(),
        rows: z.array(z.object({ label: z.string() })).min(1),
      });
      export default function Card() { return null; }
    `);
    expect(exports.props).toBeDefined();
    expect(typeof exports.default).toBe("function");
  });

  it("every bundled specifier is actually answerable — permit implies provide", () => {
    for (const specifier of JAIL_BUNDLED_PACKAGES) {
      expect(() => evaluate(`import * as m from "${specifier}"; export const r = typeof m;`), specifier).not.toThrow();
    }
  });

  it("a refusal is its OWN type, so `instanceof ZodError` never swallows it", () => {
    const source = `
      import { z } from "zod";
      export const run = () => { try { z.object({}).parse({}); return "no-throw"; }
        catch (error) { return error instanceof z.ZodError ? "misreported-as-validation" : error.name; } };
    `;
    const run = evaluate(source).run as () => string;
    // The failure must read as "the preview cannot validate", never as a
    // validation error the component would then handle as bad input.
    expect(run()).toBe("JailZodShimError");
    expect(new JailZodShimError("x") instanceof Error).toBe(true);
  });
});
