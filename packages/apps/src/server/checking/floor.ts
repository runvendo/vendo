/**
 * The checks floor as the paint seam calls it — blueprint §7.1.
 *
 * THE HOLE THIS CLOSES. The seam compiled `app.vendo` with `compileWire(content)`
 * and no options at all, so every files-first paint spoke a different dialect than
 * the generation path: inline tool references did not expand,
 * and `bindingErrors` — "the engine's unshippable gate" — was `[]` by construction
 * (`genui/wire/compile.ts`: `toolShapes === undefined ? [] : …`). Nothing checked a
 * harness's own writes. The floor was live for generation and structurally dead
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
  type AppId,
} from "@vendoai/core";
import {
  bundleOf,
  compileWire,
  isSeedComponentName,
  type AppDocument,
  type Check,
  type Finding,
  type WireCompileResult,
  type AppFloor,
} from "../../contract/index.js";
import { wireCompileOptionsFor } from "../runtime/wire-options.js";
import type { FloorDependencies } from "./deps.js";
import { screenTypesCheck } from "./facts.js";
import { prepareIslands } from "./islands.js";
import { createCheckingLayer } from "./layer.js";
import { smokeRenderIslands } from "./smoke-render.js";

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

/**
 * The island gate as a check: admission through the ambient contract
 * (`prepareIslands`) and, on an otherwise-clean set, the crash gate
 * (`smokeRenderIslands`) — the same two the create validator runs, ordered the
 * same way, so a cheap failure never pays for a render.
 *
 * SEEDED seats are skipped. These rules are the GENERATED-island contract — no
 * imports, ambient Kit only, no hand-typed constant feeding displayed math — and
 * captured HOST source cannot satisfy them by construction: it brings its own
 * imports and its numbers are the host's own (the real Maple capture blocks on
 * `pad = 6`, SVG chart padding). Every block reaches the builder verbatim as a
 * repair instruction, and on source the person did not write the only edit that
 * clears it is to stop rendering the island — so the fork is silently replaced
 * by plain host components. A capture missing a default export is refused at the
 * seed doors themselves (generation/engine.ts, remix/seed-surface.ts).
 *
 * By NAME, never by `origin`: this check also runs over a compiled `app.vendo`,
 * whose components are bare source strings, and `bundleOf` reads those as
 * `authored` — an origin test would silently do nothing on exactly the path
 * that matters.
 */
const islandsCheck = (deps: FloorDependencies): Check => ({
  name: "islands-render",
  kind: "fact",
  run: async ({ document, request }) => {
    const components = Object.fromEntries(Object.entries(document.components ?? {})
      .filter(([name]) => !isSeedComponentName(name))
      .map(([name, entry]) => [name, bundleOf(entry).source]));
    if (Object.keys(components).length === 0) return [];
    const prepared = await prepareIslands(
      components,
      deps.tools,
      deps.catalog.map(({ name }) => name),
      // Absence is "no carve-out" — the conservative direction, and what a
      // verb call or a file save honestly has.
      request === "" ? undefined : request,
    );
    // `pipeline.smokeRender: false` turns the crash gate off, and it has to mean
    // the same thing here as it does on create. The floor read no pipeline at
    // all, so a host that had switched the render off still paid for one on
    // every commit — and got blocked by a gate it had disabled.
    const issues = prepared.issues.length > 0 || deps.pipeline?.smokeRender === false
      ? prepared.issues
      : await smokeRenderIslands({
        components: prepared.components,
        componentTools: prepared.componentTools,
        tools: deps.tools,
        toolShapes: deps.toolShapes,
      });
    // An island issue already names its island, so it has no separate locus.
    return issues.map((message) => ({ severity: "block" as const, message }));
  },
});

/**
 * THE floor: the mechanical checks every door runs on top of the layer's own
 * fact checks — the compiler static half and the island gates. One definition,
 * imported by all four doors (the paint seam below, `validate` on a document,
 * `validate` on a stored app, and the edit path), because the four used to run
 * four different subsets and an app blocked at one shipped through another.
 *
 * The AI reviewer is NOT here. It spends a model call, so it stays exactly where
 * it is today: `AppsRuntime.validate` alone.
 */
export const floorChecks = (deps: FloorDependencies): Check[] =>
  [screenTypesCheck(deps), islandsCheck(deps)];

export interface AppFloorOptions {
  /**
   * The host surface to measure against, resolved LAZILY and once.
   *
   * Lazily because building it lists the host's tools, and a floor is
   * constructed per turn but called per commit; once because a turn must not
   * change its mind about what the host has halfway through.
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
      // The compiler static half and the island gates run HERE — the paint gate
      // blocks a bad screen from a user, and this ms is off the synchronous
      // create latency budget (§7.1). The generate path uses the cheap
      // node-anchored `bindingKindIssues` walker instead; neither path runs both.
      const layer = createCheckingLayer({
        deps: resolved,
        checks: [...floorChecks(resolved), ...(checks ?? [])],
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
