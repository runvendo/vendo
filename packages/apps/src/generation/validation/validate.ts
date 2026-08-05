/**
 * Create/edit validation — the FACTS enforced on a compiled document before it
 * can become an app: the compile is complete and clean, the tree is
 * catalog-consistent, its islands are syntactically sound and render without
 * crashing, its queries name real host tools, and its bindings fit the shapes
 * those tools actually return.
 *
 * Judgment is not here and never was checkable here. Whether a number is
 * invented, a button dead, or a section beside the point is the AI reviewer's
 * call (../../checking/reviewer.ts) — the deterministic gates that used to guess
 * at it are gone.
 */
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  validateAppDocument,
  validateTree,
  type AppDocument,
  type WireCompileResult,
} from "@vendoai/core";
import {
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
import { pinComponentName } from "../../pins.js";
import { APP_NAME_MAX_CHARS } from "../contracts/sections.js";
import {
  asPayload,
  type GeneratedAppDocument,
  type GenerationDependencies,
} from "../engine.js";
import { withoutPlanVocabulary } from "../skeleton.js";
import { prepareIslands } from "./islands.js";
import { smokeRenderIslands } from "./smoke-render.js";

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
  issues.push(...compiled.issues.map(({ code, message }) => `wire ${code}: ${message}`));
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
  const appValidation = validateAppDocument({ ...document, id: "app_generation_validation" });
  if (!appValidation.ok) return { issues: [appValidation.error.message] };
  return { document, issues: [] };
};

/** Edit validation. Every per-node check is filtered against the pre-existing
 *  app the same way, so an edit that doesn't touch a stale node (a legacy
 *  Table.data prop, an already-dead button) is never blocked by that node's
 *  issue — only issues the edit newly introduces surface. Ids are stable
 *  across an edit, so a carried-over issue is a byte-identical string. */
export const validateEditedApp = async (
  app: AppDocument,
  deps: GenerationDependencies,
  source: AppDocument,
  /** The edit instruction — the user text in scope, threaded into the island
   *  law-1 scan the same way create threads its request, so a value the user
   *  themselves named is never read as a fabrication. */
  requestText?: string,
): Promise<string[]> => {
  const validation = validateAppDocument(app);
  if (!validation.ok) return [validation.error.message];
  if (app.tree?.formatVersion !== VENDO_TREE_FORMAT) return ["tree edit produced an unsupported format"];
  const treeValidation = validateTree(app.tree);
  if (!treeValidation.ok) return [treeValidation.error.message];
  const sourceTreeValidation = validateTree(source.tree);
  const carried = sourceTreeValidation.ok
    ? new Set((await catalogIssues(sourceTreeValidation.tree, source.components, deps.catalog)).map(factIssueLine))
    : new Set<string>();
  void requestText;
  return (await catalogIssues(treeValidation.tree, app.components, deps.catalog))
    .map(factIssueLine)
    .filter((issue) => !carried.has(issue));
};

/**
 * A compiled edit as the NEXT version of a stored app. The tree and its islands
 * are the model's; everything else on the document — trigger, storage, machine,
 * pins, description — is the app's own history and survives untouched. Model
 * islands go through the same ambient contract create screens them with;
 * PINNED components are captured host source on the furnishing trust path, so
 * they are neither stripped nor scanned.
 */
export const documentFromEdit = async (
  previous: AppDocument,
  compiled: WireCompileResult,
  deps: GenerationDependencies,
  instruction: string,
): Promise<{ document?: AppDocument; issues: string[] }> => {
  const structural = [
    ...(compiled.complete ? [] : ["the edited app did not parse to a complete <App> document; the change was dropped."]),
    ...compiled.issues.map(({ code, message }) => `wire ${code}: ${message}`),
    ...compiled.bindingErrors.map((error) =>
      `binding ${error.path} on node "${error.nodeId}" prop "${error.prop}": ${error.message}${error.available === undefined ? "" : ` (available: ${error.available.join(", ")})`}`),
  ];
  if (structural.length > 0) return { issues: structural };
  const app: AppDocument = {
    ...structuredClone(previous),
    ...(compiled.name === undefined ? {} : { name: compiled.name }),
    tree: asPayload(structuredClone(compiled.tree)),
  };
  const pinned = new Set((previous.pins ?? []).map((pin) => pinComponentName(pin.slot)));
  const split = (all: Record<string, string>): { pinned: Record<string, string>; model: Record<string, string> } => ({
    pinned: Object.fromEntries(Object.entries(all).filter(([name]) => pinned.has(name))),
    model: Object.fromEntries(Object.entries(all).filter(([name]) => !pinned.has(name))),
  });
  const hostComponents = deps.catalog.map(({ name }) => name);
  const parts = split(compiled.components);
  const prepared = await prepareIslands(parts.model, deps.tools, hostComponents, instruction);
  // A pre-existing island issue never blocks an unrelated edit: both prepares
  // see the SAME instruction text, so a carried-over issue stays byte-identical.
  const before = await prepareIslands(split(previous.components ?? {}).model, deps.tools, hostComponents, instruction);
  const carried = new Set(before.issues);
  const islandIssues = prepared.issues.filter((issue) => !carried.has(issue));
  const components = { ...parts.pinned, ...prepared.components };
  if (Object.keys(components).length === 0) {
    delete app.components;
    delete app.componentTools;
  } else {
    app.components = structuredClone(components);
    // componentTools stays DEFINED whenever components exist, so the renderer's
    // stamped-era rule (missing key = zero tools) applies instead of its
    // source-scan fallback.
    app.componentTools = structuredClone(prepared.componentTools);
  }
  const issues = [...islandIssues, ...await validateEditedApp(app, deps, previous, instruction)];
  return issues.length > 0 ? { issues } : { document: app, issues: [] };
};
