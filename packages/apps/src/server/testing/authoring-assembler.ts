import {
  type UIPayload,
} from "@vendoai/core";
import {
  compileWire,
  type AppDocument,
  type ScreenAssembler,
  type ScreenOutcome,
  type ScreenRequest,
} from "../../contract/index.js";
import { assembleTree, type AppsRuntime } from "../runtime/runtime.js";

/**
 * What a scripted assembly run answers: the app document it saves, or one of the
 * two non-assembling outcomes verbatim.
 */
export type AssemblerAnswer = string | ScreenOutcome;

/**
 * A screen assembler that really assembles.
 *
 * There is one engine, so a test that exercises create or edit needs something
 * in the `screen` slot. This is not a stub of the apps side: it compiles with
 * core's own compiler and lands the row through `AppsRuntime.authored` — the
 * exact write path the shipped render seam uses, so the row, the history entry,
 * the guard decision and the query resolution are all the real ones. The only
 * thing standing in for a live agent is the choice of document.
 *
 * `answer` is handed the request the runtime made and the app as it stands
 * (`null` on a create), which is what makes an EDIT expressible: the shipped
 * screen agent opens the document, rewrites it and saves the whole thing, and a
 * fixture that reads `current` does the same.
 */
export const scriptedAssembler = (
  /** A getter, because the slot is filled at compose time and the runtime it
   *  writes through is what composing RETURNS — the same knot `packages/vendo`
   *  ties. */
  runtime: () => AppsRuntime,
  answer: (
    request: ScreenRequest,
    current: AppDocument | null,
  ) => AssemblerAnswer | Promise<AssemblerAnswer>,
): ScreenAssembler => ({
  async assemble(request, ctx) {
    const current = await runtime().get(request.appId, ctx).catch(() => null);
    const answered = await answer(request, current);
    if (typeof answered !== "string") return answered;
    const compiled = compileWire(answered);
    if (compiled.issues.length > 0) {
      return { kind: "unavailable", why: compiled.issues.map(({ message }) => message).join(" ") };
    }
    await runtime().authored({ appId: request.appId, compiled }, ctx);
    // The shipped assembler paints through the render seam it wrapped its own
    // workspace with, so a fixture that only stored the row would be a quieter
    // assembler than the real one — and every test of "did the view reach the
    // surface" would pass for the wrong reason.
    request.onView?.({
      type: "data-vendo-view",
      appId: request.appId,
      payload: assembleTree({ tree: compiled.tree, components: compiled.components }) as unknown as UIPayload,
    });
    return { kind: "assembled" };
  },
});

/** The one-document case: every ask, create or edit, saves this wire. */
export const authoringAssembler = (
  runtime: () => AppsRuntime,
  wire: string,
): ScreenAssembler => scriptedAssembler(runtime, () => wire);
