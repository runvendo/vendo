import {
  type UIPayload,
  vendoViewPart,
} from "@vendoai/core";
import {
  type AppDocument,
  type ScreenAssembler,
  type ScreenOutcome,
  type ScreenRequest,
} from "../../contract/index.js";
import { assembleTree, type AppsRuntime } from "../runtime/runtime.js";

/**
 * What a scripted assembly run answers: the `app.tsx` it saves, or one of the
 * two non-assembling outcomes verbatim.
 */
export type AssemblerAnswer = string | ScreenOutcome;

/**
 * A screen assembler that really assembles.
 *
 * There is one engine, so a test that exercises create or edit needs something
 * in the `screen` slot. This is not a stub of the apps side: the screen goes
 * through the real checks floor — the five-stage component gauntlet, whose own
 * `ok` upserts the row and stores the source — so the row, the history entry,
 * the guard decision and the query execution are all the real ones. The only
 * thing standing in for a live agent is the choice of screen.
 *
 * `answer` is handed the request the runtime made and the app as it stands
 * (`null` on a create), which is what makes an EDIT expressible: the shipped
 * screen agent opens the screen, rewrites it and saves the whole thing, and a
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
    const painted = await runtime().floor(ctx).component({ appId: request.appId, source: answered });
    if (!painted.ok) return { kind: "unavailable", why: painted.blocking.join(" ") };
    // The shipped assembler paints through the render seam it wrapped its own
    // workspace with, so a fixture that only ran the gauntlet would be a quieter
    // assembler than the real one — and every test of "did the view reach the
    // surface" would pass for the wrong reason.
    const payload = assembleTree({
      tree: { nodes: Object.values(painted.nodes), root: painted.root },
    }) as unknown as UIPayload;
    (payload as { interactive?: unknown }).interactive = painted.interactive;
    const view = vendoViewPart({ appId: request.appId, payload });
    if (view !== undefined) request.onView?.(view.part);
    return { kind: "assembled" };
  },
});

/** The one-screen case: every ask, create or edit, saves this `app.tsx`. */
export const authoringAssembler = (
  runtime: () => AppsRuntime,
  screen: string,
): ScreenAssembler => scriptedAssembler(runtime, () => screen);

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
