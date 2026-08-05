/**
 * The checks floor as the paint seam calls it — blueprint §7.1.
 *
 * THE HOLE THIS CLOSES. The seam compiled `app.vendo` with `compileWire(content)`
 * and no options at all, so every files-first paint spoke a different dialect than
 * `conductor.ts`, `fill.ts` and `lanes.ts`: inline tool references did not expand,
 * and `bindingErrors` — "the engine's unshippable gate" — was `[]` by construction
 * (`genui/wire/compile.ts`: `toolShapes === undefined ? [] : …`). Nothing checked a
 * harness's own writes. The floor was live for the conductor and structurally dead
 * for every other author.
 *
 * It is RELOCATED, not rewritten. `compile` is the one dialect
 * (`../wire-options.ts`); `check` is `createCheckingLayer`, which is `factChecks`
 * plus whatever the host plugged in — the same layer `create`, `edit` and
 * `validate` run. There is no second implementation of anything here.
 *
 * The AI reviewer is deliberately absent: it spends a model call, and this runs on
 * every commit. Judgement is `validate`'s (`AppsRuntime.validate`).
 */
import {
  VENDO_APP_FORMAT,
  compileWire,
  type AppDocument,
  type AppFloor,
  type AppId,
  type Check,
  type Finding,
  type WireCompileResult,
} from "@vendoai/core";
import { wireCompileOptionsFor } from "../wire-options.js";
import type { FloorDependencies } from "./deps.js";
import { screenTypesCheck } from "./facts.js";
import { createCheckingLayer } from "./layer.js";

/** A compiled wire result as the document the checks read. The checks take a whole
 *  `AppDocument` (build contract §5) and the seam knows the id, so this is the
 *  whole translation. */
const documentOf = (appId: AppId, compiled: WireCompileResult): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: appId,
  name: compiled.name ?? "",
  ui: "tree",
  // A stored document's `tree` and the genui `Tree` are the same structure under
  // two names (the cast `generation/engine.ts` calls `asPayload`).
  tree: compiled.tree as unknown as AppDocument["tree"],
  ...(Object.keys(compiled.components).length === 0 ? {} : { components: compiled.components }),
} as AppDocument);

export interface AppFloorOptions {
  /**
   * The host surface to measure against, resolved LAZILY and once.
   *
   * Lazily because building it probes the host's read tools for shape cards, and
   * a floor is constructed per turn but called per commit; once because a turn
   * must not change its mind about what the host has halfway through.
   */
  deps: () => Promise<FloorDependencies>;
  /** The host's own plugged checks (`AppsConfig.checks`). APPENDED — a host adds
   *  findings, never removes a built-in. They fire here for the same reason they
   *  fire on create: the floor does not care who wrote the app. */
  checks?: readonly Check[];
}

export const createAppFloor = ({ deps, checks }: AppFloorOptions): AppFloor => {
  let resolved: Promise<FloorDependencies> | undefined;
  const once = (): Promise<FloorDependencies> => resolved ??= deps();
  return {
    async compile(text) {
      return compileWire(text, wireCompileOptionsFor(await once()));
    },
    async check({ appId, compiled }) {
      const resolved = await once();
      // The compiler static half runs HERE — the paint gate blocks a bad screen
      // from a user, and this ms is off the synchronous create latency budget
      // (§7.1). The generate path uses the cheap node-anchored `bindingKindCheck`
      // instead; neither path runs both.
      const layer = createCheckingLayer({
        deps: resolved,
        checks: [screenTypesCheck(resolved), ...(checks ?? [])],
      });
      // `request: ""` for the same reason `validate` passes it: a file write
      // carries no user text, and the checks that read it treat absence as "no
      // carve-out", which is the conservative direction.
      return layer.run({ document: documentOf(appId, compiled), request: "" });
    },
  };
};

/** The findings that mean "this must not reach a screen". */
export const blocks = (findings: readonly Finding[]): Finding[] =>
  findings.filter(({ severity }) => severity === "block");
