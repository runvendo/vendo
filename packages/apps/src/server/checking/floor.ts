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
  VENDO_TREE_FORMAT,
  sha256Hex,
  type AppId,
  type TreeNode,
} from "@vendoai/core";
import {
  bundleOf,
  compileWire,
  isSeedComponentName,
  type AppDocument,
  type Check,
  type ComponentPaintResult,
  type Finding,
  type WireCompileResult,
  type AppFloor,
} from "../../contract/index.js";
// The screen engine, by its own path: the contract door does not carry it yet.
import { SCREEN_FILE, type FlatTree } from "../../contract/genui/component/index.js";
import { wireCompileOptionsFor } from "../runtime/wire-options.js";
import { checkComponentScreen, screenCatalog, screenName } from "./component-screen.js";
import type { FloorDependencies } from "./deps.js";
import { screenTypesCheck } from "./facts.js";
import { prepareIslands } from "./islands.js";
import { createCheckingLayer, runChecks } from "./layer.js";
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

const encoder = new TextEncoder();

/**
 * A COMPONENT screen as the document the checks read.
 *
 * The `.tsx` IS the app: this artifact stores no tree, which is why the document
 * check treats a missing one as no defect when `source[SCREEN_FILE]` is there
 * (facts.ts `documentIssues`). So the file is the document's substance, spelled
 * exactly as the row spells it — the `hash`/`bytes`/`text` triple `commitApp`
 * lands (`persistence/app-source.ts`) — and a check reading the source here reads
 * what it would read off the store.
 *
 * The rendered TREE rides along because this is a PAINT gate and the render has
 * just happened: it is what the person is about to see, and a check about what is
 * on screen ("no unmasked account numbers") has nothing else to read. Nothing
 * stores it; the same reasoning that makes a stored snapshot untrustworthy makes
 * this one authoritative — it is this screen, on this data, one moment ago.
 */
const screenDocumentOf = (appId: AppId, source: string, rendered: FlatTree): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: appId,
  name: screenName(source),
  ui: "tree",
  source: {
    [SCREEN_FILE]: {
      hash: `sha256:${sha256Hex(source)}`,
      bytes: encoder.encode(source).byteLength,
      text: source,
    },
  },
  // Same two casts the paint itself makes: a `FlatNode` IS a `TreeNode` with both
  // optional members present, and a stored document's `tree` and the genui `Tree`
  // are one structure under two names.
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: rendered.root,
    nodes: Object.values(rendered.nodes) as TreeNode[],
  } as unknown as AppDocument["tree"],
});

/** A host check's finding as one refusal line, in the SAME shape the wire path's
 *  operator log prints it (`generation/render-seam.ts`): its provenance, its
 *  locus, then the check's own sentence VERBATIM. The sentence is the part that
 *  teaches, so nothing rewrites it; the name is what tells whoever reads the log
 *  which contributed check objected, since every other refusal here is the
 *  gauntlet's. */
const refusalLine = ({ check, where, message }: Finding): string =>
  [check === undefined ? undefined : `[${check}]`, where, message]
    .filter((part) => part !== undefined)
    .join(" ");

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
  /**
   * A component screen's own queries, RUN — stage 4 of the gauntlet, which boots
   * the screen on the answers a tool really gave.
   *
   * Injected because this is the one thing in the gauntlet that touches the
   * outside world: the caller holds the guard-bound caller and the turn's ctx, so
   * every query rides one guard decision, this person's authority and the app
   * venue, exactly as `AppsRuntime.authored` resolves a tree's queries. Absent,
   * `component` refuses — a gate that could not execute the screen must never
   * answer "fine".
   */
  runQuery?: (appId: AppId, tool: string, input?: unknown) => Promise<unknown>;
  /**
   * The row half of a component screen's paint (`AppsRuntime.authoredScreen`).
   *
   * The render seam calls its `authoredApp` for a wire document and has no such
   * call for `app.tsx`, so the gauntlet's own `ok` — which IS the seam's paint gate
   * — is what calls this. That keeps "a paint is what creates the row" true for
   * both artifacts, which is what `create` reads the row's existence AS.
   *
   * The screen it paints rides as the SECOND argument, beside the row's own
   * fields rather than inside them: a component artifact has no tree to store, so
   * the screen's text IS the app, and this is the one call that fires only when
   * the gauntlet admitted it. A generic workspace diff lands the file whether or
   * not the screen was refused, which is how a screen the floor would not render
   * became the app's stored screen.
   */
  delivered?: (input: { appId: AppId; name: string }, source: string) => Promise<void>;
  /**
   * The other half of the same seam: this screen was REFUSED, with the sentences
   * the caller is about to receive.
   *
   * A refusal has to be answerable. Without this, an `edit` whose save the floor
   * refused reads the unchanged row back and reports it as a clean receipt — the
   * person is told their change landed. Everything that could say otherwise knows
   * it here and nowhere else.
   */
  refused?: (input: { appId: AppId; blocking: readonly string[] }) => Promise<void>;
}

export const createAppFloor = ({ deps, checks, runQuery, delivered, refused }: AppFloorOptions): AppFloor => {
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
    /**
     * The COMPONENT screen's gauntlet (`checkComponentScreen`), as the paint gate.
     *
     * Here for the same reason `check` is: the seam never learns to read the
     * artifact, so every author's screen — our loop, Claude Code, a person with an
     * editor — faces the identical five stages, and a refusal is the gauntlet's own
     * repair instructions VERBATIM. They are written to be read by whatever fixes
     * the screen; a caller that rewrote them would lose the part that teaches.
     */
    async component({ appId, source }) {
      /** Every way this gate says no, through one door: the sentences reach the
       *  caller exactly as they were written, and the write path is told there was
       *  a refusal at all. A `refused` that fails is not a verdict — swallowing the
       *  refusal because the recorder broke would paint the screen the floor just
       *  turned down. */
      const refuse = async (blocking: readonly string[]): Promise<ComponentPaintResult> => {
        try {
          await refused?.({ appId, blocking });
        } catch (error) {
          console.error(
            `[vendo] ${appId}'s refusal could not be recorded, so nothing will answer for it —`
            + ` ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return { ok: false, blocking };
      };
      if (runQuery === undefined) {
        return refuse(["this deployment composed no query runner for the checks floor, so the screen's"
          + " queries could not be executed and nothing about it was checked"]);
      }
      const resolved = await once();
      const checked = await checkComponentScreen({
        source,
        hostTools: resolved.tools ?? [],
        catalog: screenCatalog(resolved.catalog),
        runQuery: (tool, input) => runQuery(appId, tool, input),
      });
      if (!checked.ok || checked.compiled === undefined || checked.initialTree === undefined) {
        return refuse(checked.issues.map(({ message }) => message));
      }
      // The host's own plugged checks, AFTER the gauntlet's five stages and still
      // before the paint.
      //
      // After, because the order is forced twice over: a check reads a whole
      // document, and this artifact's document is only complete once the screen has
      // rendered (stage 4) and its tree has been admitted (stage 5) — and a screen
      // that does not compile or type-check has nothing for a host check to be
      // right about. Before, because a `block` from a host check must refuse the
      // paint exactly as a gauntlet issue does: `delivered` below IS the paint, and
      // a refused screen that still earned a row is a screen nobody can see and an
      // app the list shows.
      //
      // The built-in fact checks are deliberately NOT here — they read a WIRE tree,
      // whose vocabulary has neither the engine's `#text` runs nor the Kit's
      // element-slot components, so they would refuse screens the renderer paints.
      // The gauntlet above is this artifact's mechanical floor. `runChecks` is the
      // layer's own runner, so a host check is untrusted code here exactly as it is
      // everywhere else: one that throws degrades to a `warn` and never takes the
      // app down with it. `request: ""` for the reason `check` passes it above.
      const findings = blocks(await runChecks(checks ?? [], {
        document: screenDocumentOf(appId, source, checked.initialTree),
        request: "",
      }));
      if (findings.length > 0) return refuse(findings.map(refusalLine));
      // BEFORE the paint is handed back, because the source commit that follows it
      // needs the row to exist (`commitSource`) and `create` reads the row as the
      // proof that something rendered.
      await delivered?.({ appId, name: screenName(source) }, source);
      return {
        ok: true,
        // A `FlatNode` IS a `TreeNode` with both optional members present — the
        // same reading the gauntlet's own tree stage takes of it.
        nodes: checked.initialTree.nodes as Record<string, TreeNode>,
        root: checked.initialTree.root,
        interactive: {
          compiledSource: checked.compiled,
          queries: checked.queries ?? {},
          queryPlan: checked.queryPlan ?? [],
        },
      };
    },
  };
};

/** The findings that mean "this must not reach a screen". */
export const blocks = (findings: readonly Finding[]): Finding[] =>
  findings.filter(({ severity }) => severity === "block");
