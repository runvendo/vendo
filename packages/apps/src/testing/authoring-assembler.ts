import { compileWire, type ScreenAssembler } from "@vendoai/core";
import type { AppsRuntime } from "../runtime.js";

/**
 * A screen assembler that really assembles.
 *
 * `vendo_make` has one engine, so a test that exercises the front door needs
 * something in the `screen` slot. This is not a stub of the apps side: it
 * compiles with core's own compiler and lands the row through
 * `AppsRuntime.authored` — the exact write path the shipped render seam uses, so
 * the row, the guard decision and the query resolution are all the real ones.
 * The only thing standing in for a live agent is the document itself, which is
 * fixed rather than generated.
 */
export const authoringAssembler = (
  /** A getter, because the slot is filled at compose time and the runtime it
   *  writes through is what composing RETURNS — the same knot `packages/vendo`
   *  ties. */
  runtime: () => AppsRuntime,
  wire: string,
): ScreenAssembler => ({
  async assemble({ appId }, ctx) {
    const compiled = compileWire(wire);
    if (compiled.issues.length > 0) {
      return { kind: "unavailable", why: compiled.issues.map(({ message }) => message).join(" ") };
    }
    await runtime().authored({ appId, compiled }, ctx);
    return { kind: "assembled" };
  },
});
