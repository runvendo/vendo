/**
 * Create validation — the FACTS enforced on a compiled document before it can
 * become an app: the compile is complete and clean, the tree is
 * catalog-consistent, its islands are syntactically sound and render without
 * crashing, its queries name real host tools, and its bindings fit the shapes
 * those tools actually return.
 *
 * EDIT validation is not here and no longer exists as a thing of its own. Since
 * "the brain dies" (9a3e81342) an edit is the screen assembler rewriting the
 * app's own `app.vendo` and saving it, so the save is checked by the paint
 * seam's floor (../../checking/floor.ts) like every other author's commit.
 *
 * Judgment is not here and never was checkable here. Whether a number is
 * invented, a button dead, or a section beside the point is the AI reviewer's
 * call (../../checking/reviewer.ts) — the deterministic gates that used to guess
 * at it are gone.
 */
import {
  isAdvisoryWireIssue,
  VENDO_APP_FORMAT,
  validateAppDocument,
  type WireCompileResult,
} from "@vendoai/core";
import {
  APP_NAME_MAX_CHARS,
  bindingKindIssues,
  catalogIssues,
  exprIssues,
  factIssueLine,
  hostReshapeIssues,
  interpolationIssues,
  kitSlotIssues,
  queryInputIssues,
  unknownToolIssues,
} from "../../checking/facts.js";
import { prepareIslands } from "../../checking/islands.js";
import { smokeRenderIslands } from "../../checking/smoke-render.js";
import {
  asPayload,
  type GeneratedAppDocument,
  type GenerationDependencies,
} from "../engine.js";
import { withoutPlanVocabulary } from "../skeleton.js";

/** The id a document that is not stored is checked under. A freshly compiled
 *  document has no id of its own, and both doors that hold one — create
 *  validation below and `validate({ document })` — need the checks to read a
 *  whole `AppDocument`. */
export const UNSTORED_APP_ID = "app_generation_validation";

/** The compile issues a door must REFUSE, as the sentences it speaks.
 *
 *  Advisory codes drop out here, from the one classification every door shares
 *  (`isAdvisoryWireIssue`) rather than a list per door. Mapping EVERY wire issue
 *  to a block is what made this door disagree with the paint seam, which
 *  refuses only what did not parse: `wire-id-ignored` is what our own
 *  `printWire({ includeIds: true })` stamps on an app's `app.vendo`, so the seam
 *  painted that source and `validate({ document })` refused the same bytes. */
const blockingWireIssues = ({ issues }: WireCompileResult): string[] =>
  issues
    .filter((issue) => !isAdvisoryWireIssue(issue))
    .map(({ code, message }) => `wire ${code}: ${message}`);

/** Create validation: the compile must be complete and clean, the tree
 *  catalog-consistent and renderable, islands syntactically sound, queries
 *  aimed at real host tools, bindings shape-checked, and the assembled
 *  document valid. */
export const validateCompiledCreate = async (
  compiled: WireCompileResult,
  deps: GenerationDependencies,
  /** The user's request text, threaded into the island law-1 scan so the
   *  user's own numbers are never refused as invented data (rematch
   *  2026-07-25 rows H12/H14). Absent → no carve-out. */
  requestText?: string,
): Promise<{ document?: GeneratedAppDocument; issues: string[] }> => {
  const issues: string[] = [];
  if (!compiled.complete) issues.push("wire did not parse to a complete <App> document");
  issues.push(...blockingWireIssues(compiled));
  const name = compiled.name?.trim() ?? "";
  if (name === "") {
    issues.push('App must carry a non-empty name="..." attribute');
  } else if (name.length > APP_NAME_MAX_CHARS) {
    issues.push(`App name="${name}" is ${name.length} characters — name is the app's display title (at most ${APP_NAME_MAX_CHARS} characters); write a short human title, never the request echoed back`);
  }
  // The direct path (the brain writing a whole app in one shot) has no fill
  // worker and no spliceFragment to catch it copying its OWN plan syntax
  // (skeleton.ts's withoutPlanVocabulary) — so the same defence runs here,
  // on every node the compile produced, before any check reads them.
  const tree = { ...compiled.tree, nodes: compiled.tree.nodes.map(withoutPlanVocabulary) };
  const prepared = await prepareIslands(compiled.components, deps.tools, deps.catalog.map(({ name: componentName }) => componentName), requestText);
  const components = Object.keys(prepared.components).length === 0 ? undefined : prepared.components;
  issues.push(...prepared.issues);
  issues.push(...unknownToolIssues(tree, deps.tools).map(factIssueLine));
  issues.push(...compiled.bindingErrors.map((error) =>
    `binding ${error.path} on node "${error.nodeId}" prop "${error.prop}": ${error.message}${error.available === undefined ? "" : ` (available: ${error.available.join(", ")})`}`));
  issues.push(...bindingKindIssues(tree, deps).map(factIssueLine));
  issues.push(...kitSlotIssues(tree, deps).map(factIssueLine));
  issues.push(...hostReshapeIssues(tree, deps).map(factIssueLine));
  issues.push(...exprIssues(tree, deps).map(factIssueLine));
  issues.push(...queryInputIssues(tree).map(factIssueLine));
  issues.push(...interpolationIssues(tree).map(factIssueLine));
  issues.push(...(await catalogIssues(tree, components, deps.catalog)).map(factIssueLine));
  if (issues.length > 0) return { issues };
  // The smoke-render gate (crash classes the 2026-07-21 gate shipped: React
  // #310 hooks-in-map, undefined names, unguarded-data throws). Runs LAST,
  // only on otherwise-clean documents, so cheap failures never pay for a
  // render; source-keyed caching makes repair/end-pass revalidation of
  // unchanged islands free.
  if (components !== undefined && deps.pipeline?.smokeRender !== false) {
    issues.push(...await smokeRenderIslands({
      components,
      componentTools: prepared.componentTools,
      tools: deps.tools,
      toolShapes: deps.toolShapes,
    }));
    if (issues.length > 0) return { issues };
  }
  const document: GeneratedAppDocument = {
    format: VENDO_APP_FORMAT,
    name,
    ui: "tree",
    tree: asPayload(structuredClone(tree)),
    ...(components === undefined ? {} : {
      components: structuredClone(components),
      // The compiler-stamped per-island tool manifest (least privilege: an
      // island with no tools carries an explicit empty list).
      componentTools: structuredClone(prepared.componentTools),
    }),
  };
  const appValidation = validateAppDocument({ ...document, id: UNSTORED_APP_ID });
  if (!appValidation.ok) return { issues: [appValidation.error.message] };
  return { document, issues: [] };
};
