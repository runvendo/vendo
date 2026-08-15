/**
 * The checks floor as the paint seam calls it — blueprint §7.1.
 *
 * The seam never learns to read `app.tsx`: every author's screen — our loop,
 * Claude Code, a person with an editor — faces the identical gauntlet here, and a
 * refusal is the gauntlet's own repair instructions verbatim.
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
  type AppDocument,
  type Check,
  type ComponentPaintResult,
  type Finding,
  type AppFloor,
} from "../../contract/index.js";
// The screen engine, by its own path: the contract door does not carry it yet.
import { SCREEN_FILE, type FlatTree } from "../../contract/genui/component/index.js";
import { checkComponentScreen, screenName } from "./component-screen.js";
import { screenCatalog } from "./screen-typings.js";
import type { FloorDependencies } from "./deps.js";
import { screenTypesCheck } from "./facts.js";
import { runChecks } from "./layer.js";
import type { ScreenToolchain } from "./toolchain.js";

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
 * THE floor: the mechanical checks every door runs on top of the layer's own
 * fact checks. One definition, imported by every door, because they used to run
 * different subsets and an app blocked at one shipped through another.
 *
 * The AI reviewer is NOT here. It spends a model call, so it stays exactly where
 * it is today: `AppsRuntime.validate` alone.
 */
export const floorChecks = (deps: FloorDependencies): Check[] => [screenTypesCheck(deps)];

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
  /**
   * What compiles, type-checks and paints a component screen (`AppsConfig.toolchain`).
   *
   * The gauntlet's three stages that cannot run in every venue, behind one slot,
   * so a deployment whose checks happen somewhere without esbuild, the
   * `typescript` package and the QuickJS build can still run every other stage
   * here. Passed through unresolved: the gauntlet holds the one default, so a
   * toolchain installed after a floor was built still reaches that floor.
   */
  toolchain?: ScreenToolchain;
}

export const createAppFloor = (
  { deps, checks, runQuery, delivered, refused, toolchain }: AppFloorOptions,
): AppFloor => {
  let resolved: Promise<FloorDependencies> | undefined;
  const once = (): Promise<FloorDependencies> => resolved ??= deps();
  return {
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
        ...(resolved.routes === undefined ? {} : { routes: resolved.routes }),
        runQuery: (tool, input) => runQuery(appId, tool, input),
        toolchain,
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
