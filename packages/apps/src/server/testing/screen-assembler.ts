import type {
  AppDocument,
  ScreenAssembler,
  ScreenOutcome,
  ScreenRequest,
} from "../../contract/index.js";
import type { AppsRuntime } from "../runtime/runtime.js";

/** What a scripted screen run answers: the `app.tsx` it saves, or one of the two
 *  non-assembling outcomes verbatim. */
export type ScreenAnswer = string | ScreenOutcome;

/**
 * A COMPONENT screen assembler that really assembles.
 *
 * There is one engine, so a test that exercises create or edit needs something
 * in the `screen` slot. This is not a stub of the apps side: `answer` returns the
 * `app.tsx` a screen agent would have written and it lands through
 * `authoredScreen` — the door the shipped floor's paint half calls — so the row,
 * the version and the CAS bracket are all the real ones. The only thing standing
 * in for a live agent is the choice of source.
 *
 * `answer` is handed the request the runtime made and the app as it stands
 * (`null` on a create), which is what makes an EDIT expressible: the shipped
 * screen agent opens the document, rewrites it and saves the whole thing.
 */
export const scriptedScreenAssembler = (
  /** A getter, because the slot is filled at compose time and the runtime it
   *  writes through is what composing RETURNS — the same knot `packages/vendo`
   *  ties. */
  runtime: () => AppsRuntime,
  answer: (
    request: ScreenRequest,
    current: AppDocument | null,
  ) => ScreenAnswer | Promise<ScreenAnswer>,
): ScreenAssembler => ({
  async assemble(request, ctx) {
    const current = await runtime().get(request.appId, ctx).catch(() => null);
    const answered = await answer(request, current);
    if (typeof answered !== "string") return answered;
    await runtime().authoredScreen({
      appId: request.appId,
      name: current?.name ?? "Untitled app",
      source: answered,
    }, ctx);
    return { kind: "assembled" };
  },
});
