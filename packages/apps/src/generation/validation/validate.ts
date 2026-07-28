/**
 * Create/edit validation — everything ENFORCED on a compiled document: the
 * compile must be complete and clean, the tree catalog-consistent and
 * renderable, islands syntactically sound, queries aimed at real host tools,
 * bindings shape-checked, and the assembled document valid.
 */
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  validateAppDocument,
  validateTree,
  type AppDocument,
  type Tree,
  type WireCompileResult,
} from "@vendoai/core";
import {
  bindingKindIssues,
  catalogIssues,
  factIssueLine,
  hostReshapeIssues,
  interpolationIssues,
  isRecord,
  isRuntimeBound,
  kitSlotIssues,
  queryInputIssues,
  unknownToolIssues,
} from "../../checking/facts.js";
import { APP_NAME_MAX_CHARS } from "../contracts/sections.js";
import type {
  GeneratedAppDocument,
  GenerationDependencies,
} from "../engine.js";
import { actionIssues } from "./actions.js";
import { capabilitySubstitutionIssues } from "./capability-substitution.js";
import { DISCLAIMER_TEXT } from "./disclaimer.js";
import { literalDataIssues } from "./literals.js";
import { prepareIslands } from "./islands.js";
import { smokeRenderIslands } from "./smoke-render.js";

/** The per-region unavailability line the repair stage substitutes for a node
 *  it cannot fix (stages/repair.ts disclaims through it). Lives in
 *  ./disclaimer.js so the empty-document gate below and the
 *  capability-substitution gate can both quote it without an import cycle;
 *  re-exported here, and by repair, for their existing importers. */
export { DISCLAIMER_TEXT };

/** Re-gate 2026-07-26 finding 3 — the title-only empty app (12 across arms
 *  A/B, reproducing on re-open): a document whose rooted tree renders nothing
 *  data-bearing or interactive beyond headings/copy in layout containers.
 *  Content is any generated island, host component, node with a data/state/
 *  action binding, or Kit/prewired component beyond the copy-only set below.
 *  An honest `Disclaimer` IS content — it is the legal move when no tool
 *  backs the ask — so a title+Disclaimer app passes untouched. So does the
 *  repair stage's DISCLAIMER_TEXT region substitution: disclaimed regions are
 *  a deliberate repair outcome, and the runtime's disclaimer-only gate
 *  (isDisclaimerOnlyTree, 0.4.5 defect D) already fails a build whose EVERY
 *  region was disclaimed away with the sharper host-capability reason —
 *  bouncing those trees back to repair here would fight that mechanism.
 *
 *  Text is variant-aware: the shell class this gate targets is the bare
 *  heading (sometimes plus a caption/label) — so only the heading/caption/
 *  label variants count as shell material. A static Text carrying real BODY
 *  copy (default variant, non-empty string) IS content: purely informational
 *  apps are legitimate, and the @vendoai-corpus/express-host e2e's scripted
 *  body-copy app 400'ing at create was this gate's first false positive. */
const COPY_ONLY_COMPONENTS: ReadonlySet<string> = new Set([
  "Stack", "Row", "Grid", "Surface", "Divider", "Skeleton", "Card", "Text", "Badge",
]);

/** Text variants that read as chrome, not body copy. */
const SHELL_TEXT_VARIANTS: ReadonlySet<string> = new Set(["heading", "caption", "label"]);

/** A Text node whose static string is real body copy (default/body variant,
 *  non-empty text). Bound values are handled by the binding check instead. */
const isBodyCopyText = (node: Tree["nodes"][number]): boolean => {
  if (node.component !== "Text") return false;
  const variant = node.props?.["variant"];
  if (typeof variant === "string" && SHELL_TEXT_VARIANTS.has(variant)) return false;
  const text = node.props?.["text"];
  return typeof text === "string" && text.trim().length > 0;
};

/** Any data/state/action binding reachable in a props value. */
const hasRuntimeBinding = (value: unknown): boolean => {
  if (isRuntimeBound(value)) return true;
  if (Array.isArray(value)) return value.some(hasRuntimeBinding);
  if (isRecord(value)) return Object.values(value).some(hasRuntimeBinding);
  return false;
};

const emptyDocumentIssues = (tree: Tree): string[] => {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const pending = [tree.root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (node === undefined) continue;
    pending.push(...(node.children ?? []));
    if (node.source === "generated" || node.source === "host") return [];
    if (!COPY_ONLY_COMPONENTS.has(node.component)) return [];
    // Containment, not equality: the repair recompile merges adjacent Text
    // nodes, so a disclaimed region can arrive embedded in a longer string.
    if (node.component === "Text" && typeof node.props?.["text"] === "string"
      && node.props["text"].includes(DISCLAIMER_TEXT)) return [];
    if (isBodyCopyText(node)) return [];
    if (node.props !== undefined && Object.values(node.props).some(hasRuntimeBinding)) return [];
  }
  return [
    "the app has a title and no content — every rooted node is a heading, static copy, or an empty layout container. Add the sections that answer the ask (tables, stats, charts, forms, or islands over real tool data), or an honest Disclaimer stating why the data can't be shown if nothing can.",
  ];
};

const rootedRenderIssues = (tree: Tree): string[] => {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const pending = [tree.root];
  const visited = new Set<string>();
  const issues: string[] = [];
  let hasRenderableContent = false;
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (node === undefined) {
      issues.push(`rooted node "${id}" is missing; persisted edits cannot rely on streaming placeholders`);
      continue;
    }
    if (node.source === "generated" || node.source === "host") {
      hasRenderableContent = true;
    } else if (node.component === "Text") {
      const text = node.props?.text;
      if (text !== undefined && text !== null && String(text).trim() !== "") hasRenderableContent = true;
    } else if (!new Set(["Stack", "Row", "Grid"]).has(node.component)) {
      hasRenderableContent = true;
    }
    pending.push(...(node.children ?? []));
  }
  if (!hasRenderableContent) {
    issues.push(`tree root "${tree.root}" renders an empty layout; keep at least one attached, visible node`);
  }
  return issues;
};

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
  const prepared = await prepareIslands(compiled.components, deps.tools, deps.catalog.map(({ name: componentName }) => componentName), requestText);
  const components = Object.keys(prepared.components).length === 0 ? undefined : prepared.components;
  issues.push(...prepared.issues);
  issues.push(...unknownToolIssues(compiled.tree, deps.tools).map(factIssueLine));
  issues.push(...compiled.bindingErrors.map((error) =>
    `binding ${error.path} on node "${error.nodeId}" prop "${error.prop}": ${error.message}${error.available === undefined ? "" : ` (available: ${error.available.join(", ")})`}`));
  issues.push(...bindingKindIssues(compiled.tree, deps).map(factIssueLine));
  issues.push(...kitSlotIssues(compiled.tree, deps).map(factIssueLine));
  issues.push(...hostReshapeIssues(compiled.tree, deps).map(factIssueLine));
  issues.push(...queryInputIssues(compiled.tree).map(factIssueLine));
  issues.push(...interpolationIssues(compiled.tree).map(factIssueLine));
  issues.push(...(await catalogIssues(compiled.tree, components, deps.catalog)).map(factIssueLine));
  // Law 1 is checkable only when a tool surface exists to trace data to —
  // a tool-less composition (fresh init, bare tests) has nothing to bind.
  if (deps.tools !== undefined && deps.tools.length > 0) {
    issues.push(...literalDataIssues(compiled.tree, deps.catalog));
  }
  issues.push(...actionIssues(compiled.tree, deps.tools));
  // D5 — a mutating action whose target/amount is hand-typed is a write tool
  // repurposed for a capability the host lacks (the island half of the same
  // gate runs inside prepareIslands).
  issues.push(...capabilitySubstitutionIssues(compiled.tree, deps.tools, requestText));
  issues.push(...rootedRenderIssues(compiled.tree));
  issues.push(...emptyDocumentIssues(compiled.tree));
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
    tree: structuredClone(compiled.tree) as unknown as NonNullable<AppDocument["tree"]>,
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
  /** The edit instruction — the user text in scope, threaded into the
   *  capability-substitution gate the same way create threads its request, so
   *  a value the user themselves named is never read as a fabrication. */
  requestText?: string,
): Promise<string[]> => {
  const validation = validateAppDocument(app);
  if (!validation.ok) return [validation.error.message];
  if (app.tree?.formatVersion !== VENDO_TREE_FORMAT) return ["tree edit produced an unsupported format"];
  const treeValidation = validateTree(app.tree);
  if (!treeValidation.ok) return [treeValidation.error.message];
  const sourceTreeValidation = validateTree(source.tree);
  const sourceRenderIssues = sourceTreeValidation.ok
    ? new Set(rootedRenderIssues(sourceTreeValidation.tree))
    : new Set<string>();
  const sourceCatalogIssues = sourceTreeValidation.ok
    ? new Set([
      ...(await catalogIssues(sourceTreeValidation.tree, source.components, deps.catalog)).map(factIssueLine),
      ...literalDataIssues(sourceTreeValidation.tree, deps.catalog),
      ...actionIssues(sourceTreeValidation.tree, deps.tools),
      ...capabilitySubstitutionIssues(sourceTreeValidation.tree, deps.tools, requestText),
    ])
    : new Set<string>();
  return [
    ...rootedRenderIssues(treeValidation.tree).filter((issue) => !sourceRenderIssues.has(issue)),
    ...(await catalogIssues(treeValidation.tree, app.components, deps.catalog)).map(factIssueLine).filter((issue) => !sourceCatalogIssues.has(issue)),
    ...literalDataIssues(treeValidation.tree, deps.catalog).filter((issue) => !sourceCatalogIssues.has(issue)),
    ...actionIssues(treeValidation.tree, deps.tools).filter((issue) => !sourceCatalogIssues.has(issue)),
    ...capabilitySubstitutionIssues(treeValidation.tree, deps.tools, requestText).filter((issue) => !sourceCatalogIssues.has(issue)),
  ];
};
