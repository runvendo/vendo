/**
 * A zod-SHAPED shim for the jail's module table — not zod.
 *
 * WHY THIS EXISTS. Host components are registered with their props schema beside
 * them (`props: z.object({ … })`, Vendo's documented registry pattern), so the
 * captured module imports zod and the jail must answer `require("zod")` or the
 * component cannot load at all. Bundling real zod costs ~+91 KB raw / ~+23 KB
 * gzip in the jail runtime — and that runtime is inlined by `renderer.tsx` into
 * the production bundle of EVERY host that renders generated UI, so every
 * customer's end users would pay it.
 *
 * WHY A SHIM IS ENOUGH. Measured against the real captures in this repo (both
 * Cadence components, loaded through the actual jail loader with a recording
 * proxy in zod's place): the entire surface touched is
 *
 *   z.object · z.string · z.number · z.boolean · z.enum · .optional() · .describe()
 *
 * and `.parse`/`.safeParse` was called ZERO times during module evaluation and
 * render. That is the shape of the pattern: the schema is DECLARED at module
 * scope so the server can read it, and a preview supplies props directly, so
 * nothing validates at render. Both components rendered byte-identically
 * through the proxy as through real zod.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never pretends to validate. Every
 * parsing entry point THROWS a named error instead of returning a plausible
 * wrong value — a silent mis-validation inside a host's own page would be far
 * worse than the bytes it saves. If a component really does parse at render, it
 * fails loudly and diagnosably, and the fix is to bundle real zod.
 *
 * SCOPE. Only reachable through the jail's module table: code outside the jail
 * (the host's own app, the server) uses the host's own real zod, untouched.
 */

/** Entry points that would have to actually validate. Emulating these is the
 *  one thing a shim must never fake. */
const PARSERS = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync"]);

const refuse = (method: string): never => {
  throw new Error(
    `zod's ${method}() is not available in the Vendo preview sandbox: it ships a small zod-shaped shim for DECLARING prop schemas, not a validator. `
    + "This component validates at render time, which the shim cannot emulate honestly.",
  );
};

/**
 * One chainable declaration node. Every modifier (`.optional()`, `.describe()`,
 * `.min()`, `.nullable()`, …) returns another node, so any builder chain a
 * registry writes resolves; the node carries no schema meaning because nothing
 * in the jail reads one.
 */
const node = (): unknown => new Proxy(function chain() {} as object, {
  get(_target, property) {
    if (typeof property === "symbol") return undefined;
    const key = String(property);
    if (PARSERS.has(key)) return () => refuse(key);
    // `_def`/`shape`/`options`/`element` are read by tooling, never by render
    // paths; a chainable answer keeps property access from throwing.
    return node();
  },
  // `z.object({...})`, `.min(1)`, `.describe("…")` — all calls chain.
  apply: () => node(),
  // Some code probes with `in`; answer consistently with `get`.
  has: () => true,
});

/**
 * The `z` namespace. A Proxy rather than an enumerated list of builders so a
 * registry using a zod constructor we did not think of still loads instead of
 * crashing on an undefined — the failure mode a shim must avoid, since the
 * whole point is letting the component render.
 */
const z: unknown = new Proxy({}, {
  get(_target, property) {
    if (typeof property === "symbol") return undefined;
    const key = String(property);
    if (PARSERS.has(key)) return () => refuse(key);
    return node();
  },
  has: () => true,
});

/** Shaped like the zod module: the `z` namespace, its aliases, and `default`. */
export const zodShim: Record<string, unknown> = { z, default: z, ZodError: Error };
