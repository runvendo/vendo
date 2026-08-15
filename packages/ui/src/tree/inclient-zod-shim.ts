/**
 * A zod-SHAPED shim for the in-client module table — not zod.
 *
 * WHY THIS EXISTS. Host components are registered with their props schema beside
 * them (`props: z.object({ … })`, Vendo's documented registry pattern), so the
 * captured module imports zod and the mount must answer `require("zod")` or the
 * component cannot load at all. Bundling real zod costs ~+91 KB raw / ~+23 KB
 * gzip in the bundle of EVERY host that renders generated UI, so every
 * customer's end users would pay it.
 *
 * WHY A SHIM IS ENOUGH. Measured against the real captures in this repo (both
 * Cadence components, loaded through the actual mount loader with a recording
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
 * SCOPE. Only reachable through the in-client module table: code outside it
 * (the host's own app, the server) uses the host's own real zod, untouched.
 */

/** Entry points that would have to actually validate. Emulating these is the
 *  one thing a shim must never fake. */
const PARSERS = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync"]);

/** A chainable answer here would make every shim value a thenable whose `then`
 *  never calls back, so one `await` hangs the component forever. Absent is the only
 *  safe answer, and `has` says the same.
 *
 *  ONLY `then`. It is the entire thenable protocol — `catch`/`finally` live on
 *  real promises and are never read to decide whether a value is one — while
 *  `.catch(fallback)` is a real zod method on every schema (zod 3 and 4) and a
 *  namespace helper in zod 4. Blanking it broke components that declare a
 *  fallback, which is worse than the hang it was meant to prevent. */
const THENABLE_KEY = "then";

/**
 * The shim's own refusal, with its OWN type. Deliberately not a `ZodError`: if
 * a refusal were catchable as a validation error, a component's `catch (e) { if
 * (e instanceof z.ZodError) … }` would swallow it and report "invalid input"
 * when the truth is "this preview cannot validate at all".
 */
export class ZodShimError extends Error {
  override readonly name = "ZodShimError";
}

/** Stand-in for zod's own error type. Nothing ever throws it — the shim does
 *  not validate — so `instanceof` is always false, which is the honest answer. */
class ZodError extends Error {
  override readonly name = "ZodError";
}

const refuse = (method: string): never => {
  throw new ZodShimError(
    `zod's ${method}() is not available in a Vendo in-client mount: it ships a small zod-shaped shim for DECLARING prop schemas, not a validator. `
    + "This component validates at render time, which the shim cannot emulate honestly.",
  );
};

/**
 * One chainable declaration node. Every modifier (`.optional()`, `.describe()`,
 * `.min()`, `.nullable()`, …) returns another node, so any builder chain a
 * registry writes resolves; the node carries no schema meaning because nothing
 * in the mount reads one.
 */
const node = (): unknown => new Proxy(function chain() {} as object, {
  get(_target, property) {
    if (typeof property === "symbol") return undefined;
    const key = String(property);
    if (key === THENABLE_KEY) return undefined;
    if (PARSERS.has(key)) return () => refuse(key);
    // `_def`/`shape`/`options`/`element` are read by tooling, never by render
    // paths; a chainable answer keeps property access from throwing.
    return node();
  },
  // `z.object({...})`, `.min(1)`, `.describe("…")` — all calls chain.
  apply: () => node(),
  // Some code probes with `in`; answer consistently with `get`.
  has: (_target, property) => property !== THENABLE_KEY,
});

/**
 * THE MODULE ITSELF is the `z` namespace, so every import style sucrase can
 * emit resolves against it:
 *
 *   import { z } from "zod"      -> module.z      (Zod 3's documented style)
 *   import * as z from "zod"     -> the module    (Zod 4's documented style)
 *   import z from "zod"          -> module.default
 *
 * `__esModule: true` is load-bearing: without it sucrase's
 * `_interopRequireDefault` wraps the entry a second time, so `default` becomes
 * the whole module object and `z.object(...)` calls a non-function. That is the
 * permitted-but-not-usable failure this table exists to prevent, and it is why
 * the tests below assert every style rather than one.
 */
export const zodShim: Record<string, unknown> = new Proxy({}, {
  get(_target, property) {
    if (typeof property === "symbol") return undefined;
    const key = String(property);
    if (key === "__esModule") return true;
    if (key === THENABLE_KEY) return undefined;
    // The namespace and the default export are the module itself.
    if (key === "z" || key === "default") return zodShim;
    if (key === "ZodError") return ZodError;
    if (PARSERS.has(key)) return () => refuse(key);
    return node();
  },
  has: (_target, property) => property !== THENABLE_KEY,
}) as Record<string, unknown>;
