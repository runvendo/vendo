import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex, type Json } from "@vendoai/core";
import {
  seedBaselineSchema,
  type SeedBaseline,
  type SeedStyle,
} from "../formats.js";
import type TS from "typescript";
import {
  captureClosure,
  defaultExportOf,
  importSpecifiers,
  overBudgetWarning,
  portablePath,
} from "./capture.js";
import {
  exportOrigin,
  importReferenceFor,
  insideBounds,
  isInside,
  parseModuleSource,
  resolveImportSource,
  visitNodes,
  walk,
  writeIfChanged,
} from "./common.js";
import { splitSlot, type SplitInput } from "./split/index.js";
import { remixWiringSource, type WiringSlot } from "./split/wiring.js";

const MAX_SCAN_FILES = 5_000;
const ROOT_FILE = /^(?:src\/)?(?:app\/layout|app\/root|pages\/_app)\.(?:[cm]?[jt]sx?)$/u;

/** The one fix every wrapper error points at (the constraint is defended, not
 *  hidden): the wrapped child must be a single, statically importable
 *  component. */
const EXTRACT_HINT = "extract it into a component and wrap that";

/** Host plumbing a fork cannot carry across the frame boundary: router
 *  modules, and context/router-style hooks. */
const PLUMBING_MODULE = /^next\/(?:navigation|router)(?:\/|$)/u;
const PLUMBING_HOOK = /^use(?:\w*Context|Router|Pathname|SearchParams|Params)$/u;

export interface PinCaptureResult {
  captured: string[];
  drifted: string[];
  /** Slots that SPLIT this run — the ones the wiring file covers. Non-empty is
   *  what makes the report say the two hookup call sites out loud. */
  ported: string[];
  /** Baselines deleted because no wrapper names their slot this run — a stale
   *  baseline is a forkable zombie (checker round-1 ruling 2026-08-02). */
  pruned: string[];
  /** Loud wrapper errors ("file:line — message"); sync must fail on them. */
  errors: string[];
  /** `<Remixable>` wrappers sync FOUND but could not attribute to `@vendoai/ui`
   *  ("file:line — message"). Never silent: a repo whose wrappers all sit
   *  behind an unrecognized module used to sync to "0 captured, 0 drifted"
   *  with nothing said. */
  unattributed: string[];
  warnings: string[];
  /** The app-root stylesheets this walk captured. Shared with the registered
   *  component capture — the same root files, read once. */
  styles: SeedStyle[];
}

/** One `<Remixable>` element found in host source. */
interface WrapperSite {
  file: string;
  line: number;
  /** The child's JSX tag ("NetWorthCard" or "Cards.NetWorth"). */
  childTag: string;
  /** Child attributes carrying function-typed values at the call site. */
  functionProps: string[];
}

/** A site whose child resolved to its owning module. */
interface ResolvedSite extends WrapperSite {
  slot: string;
  realFile: string;
  source: string;
}

function lineOf(sf: TS.SourceFile, node: TS.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function tagText(ts: typeof TS, tagName: TS.JsxTagNameExpression, sf: TS.SourceFile): string {
  return ts.isIdentifier(tagName) ? tagName.text : tagName.getText(sf);
}

/** The modules whose `Remixable` export is OURS: `@vendoai/ui` (any subpath —
 *  the export lives on `@vendoai/ui/chrome`), the `vendoai` alias, and the
 *  `@vendoai/vendo` umbrella re-export. */
const REMIXABLE_MODULE = /^(?:@vendoai\/(?:ui|vendo)|vendoai)(?:\/|$)/u;

/** Local bindings PROVEN to be our `Remixable` at the use site: named imports
 *  (aliased or not — `import { Remixable as Remix }`) and namespace imports,
 *  from a REMIXABLE_MODULE directly or through the host's own re-export shim.
 *  A same-named component from anywhere else is not ours and is never
 *  captured (checker round-1 ruling 2026-08-02) — but it is no longer silent:
 *  every unproven local name is kept so the wrapper using it can say so. */
interface RemixableBindings {
  names: Set<string>;
  namespaces: Set<string>;
  /** Local name → the specifier it was imported from, for names that LOOK like
   *  our `Remixable` and were not proven. Absent from the map = not imported
   *  at all. */
  unproven: Map<string, string>;
}

/** Where a wrapper's `Remixable` is resolved from. */
interface BindingScope {
  file: string;
  root: string;
  extraRoots: readonly string[];
}

/**
 * Is `imported` from `specifier` OUR Remixable? A direct `@vendoai/ui` import
 * is proof on its face. Anything else is proof only if reading the host's own
 * modules says so: hosts that forbid deep `@vendoai/*` imports re-export
 * `Remixable` through a kit module (`@host/vendo-kit`), and following that
 * module's exports back to `@vendoai/ui` is a fact, not a guess. A specifier
 * that cannot be followed is left unproven rather than assumed either way.
 */
async function isOurRemixable(specifier: string, imported: string, scope: BindingScope): Promise<boolean> {
  if (REMIXABLE_MODULE.test(specifier)) return true;
  const origin = await exportOrigin({
    importer: scope.file,
    specifier,
    exported: imported,
    root: scope.root,
    extraRoots: scope.extraRoots,
  });
  return origin !== null && REMIXABLE_MODULE.test(origin);
}

async function remixableBindings(ts: typeof TS, sf: TS.SourceFile, scope: BindingScope): Promise<RemixableBindings> {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const unproven = new Map<string, string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    // A DEFAULT import is never ours — `Remixable` is a named export — but
    // recording it keeps the miss message honest about where the name came from
    // instead of claiming it was never imported.
    if (clause.name !== undefined) unproven.set(clause.name.text, specifier);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      // A namespace only matters when the file writes `<Ns.Remixable>`, and
      // proving that asks the same question a named import does.
      const local = bindings.name.text;
      if (await isOurRemixable(specifier, "Remixable", scope)) namespaces.add(local);
      else unproven.set(local, specifier);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported !== "Remixable") continue;
      if (await isOurRemixable(specifier, imported, scope)) names.add(element.name.text);
      else unproven.set(element.name.text, specifier);
    }
  }
  return { names, namespaces, unproven };
}

function isRemixableTag(
  ts: typeof TS,
  tagName: TS.JsxTagNameExpression,
  sf: TS.SourceFile,
  bindings: RemixableBindings,
): boolean {
  const text = tagText(ts, tagName, sf);
  if (ts.isIdentifier(tagName)) return bindings.names.has(text);
  const namespace = text.slice(0, text.indexOf("."));
  return text.slice(text.lastIndexOf(".") + 1) === "Remixable" && bindings.namespaces.has(namespace);
}

function childAttributes(ts: typeof TS, child: TS.JsxElement | TS.JsxSelfClosingElement): TS.JsxAttributes {
  return ts.isJsxSelfClosingElement(child) ? child.attributes : child.openingElement.attributes;
}

/** Call-site props the frame boundary cannot carry: literal function values,
 *  and `on*`-named props (a bound handler is a function even when static
 *  analysis only sees an identifier). */
function functionTypedProps(ts: typeof TS, child: TS.JsxElement | TS.JsxSelfClosingElement): string[] {
  const names: string[] = [];
  for (const property of childAttributes(ts, child).properties) {
    if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name)) continue;
    const initializer = property.initializer;
    if (initializer === undefined || !ts.isJsxExpression(initializer) || initializer.expression === undefined) continue;
    const expression = initializer.expression;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
      || /^on[A-Z]/u.test(property.name.text)) {
      names.push(property.name.text);
    }
  }
  return names;
}

/** The local binding a tag that NAMES `Remixable` reads through — `Remixable`
 *  itself, or `Kit` in `<Kit.Remixable>`. Null for every other tag. */
function remixableTagBinding(text: string): string | null {
  if (text.slice(text.lastIndexOf(".") + 1) !== "Remixable") return null;
  const dot = text.indexOf(".");
  return dot === -1 ? text : text.slice(0, dot);
}

const quoted = (value: string): string => `"${value}"`;

/** `"@vendoai/ui/chrome"`, quotes included, assembled at runtime: the
 *  dependency guard's static scan reads import-shaped text even inside a string
 *  literal, and actions may not depend on `@vendoai/ui`. */
const CHROME = quoted(["@vendoai", "ui", "chrome"].join("/"));
const IMPORT_FIX = `\`import { Remixable } from ${CHROME}\``;
const REEXPORT_FIX = `\`export { Remixable } from ${CHROME}\``;

/** THE loud miss. What happened, why, and the exact edits that fix it —
 *  because the alternative a host actually experienced is `pins: 0 captured,
 *  0 drifted` printed over a file with `<Remixable>` right there in it. */
function unattributedWrapper(at: string, tag: string, local: string, specifier: string | undefined): string {
  const head = `${at} — <${tag}> was NOT captured: \`${local}\``;
  return specifier === undefined
    ? `${head} is not imported in this file, so sync cannot tell whether it is Vendo's. Import it (${IMPORT_FIX}, or from one of your own modules that re-exports it) and re-run \`vendo sync\`. If this is your own component, rename it — Remixable is Vendo's wrap marker.`
    : `${head} comes from ${quoted(specifier)}, and following that module's exports never reached @vendoai/ui's Remixable. Fix it either way: import it directly (${IMPORT_FIX}), or re-export it from ${quoted(specifier)} (${REEXPORT_FIX}). Then re-run \`vendo sync\`.`;
}

/** Every `<Remixable>` usage in one module: the ones that capture, loud errors
 *  for children that are not a single component element, and loud misses for
 *  wrappers whose `Remixable` could not be traced to `@vendoai/ui`. */
async function wrapperSites(
  source: string,
  file: string,
  relativeFile: string,
  scope: BindingScope,
): Promise<{ sites: WrapperSite[]; errors: string[]; unattributed: string[] }> {
  const sites: WrapperSite[] = [];
  const errors: string[] = [];
  const unattributed: string[] = [];
  // The token's absence is a cheap skip that avoids parsing every walked module.
  if (!source.includes("Remixable")) return { sites, errors, unattributed };
  const parsed = parseModuleSource(source, file);
  if (!parsed) return { sites, errors, unattributed };
  const { ts, sf } = parsed;
  const bindings = await remixableBindings(ts, sf, scope);
  visitNodes(ts, sf, (node) => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const tagName = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
    const line = lineOf(sf, node);
    if (!isRemixableTag(ts, tagName, sf, bindings)) {
      const text = tagText(ts, tagName, sf);
      const local = remixableTagBinding(text);
      if (local !== null) {
        unattributed.push(unattributedWrapper(`${relativeFile}:${line}`, text, local, bindings.unproven.get(local)));
      }
      return;
    }
    if (!ts.isJsxElement(node)) {
      errors.push(`${relativeFile}:${line} — <Remixable /> wraps nothing; put exactly one component element inside it`);
      return;
    }
    // Whitespace and comment-only expression containers ({/* … */}) render
    // nothing and do not count against the single-child rule.
    const children = node.children.filter((child) =>
      !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces)
      && !(ts.isJsxExpression(child) && child.expression === undefined));
    const [child] = children;
    if (children.length !== 1 || child === undefined
      || !(ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child))) {
      errors.push(`${relativeFile}:${line} — <Remixable> must wrap exactly one component element; ${EXTRACT_HINT}`);
      return;
    }
    const childName = tagText(ts, ts.isJsxSelfClosingElement(child) ? child.tagName : child.openingElement.tagName, sf);
    if (!/^[A-Z]/u.test(childName.slice(childName.lastIndexOf(".") + 1))) {
      errors.push(`${relativeFile}:${line} — <Remixable> wraps inline JSX (<${childName}>); ${EXTRACT_HINT}`);
      return;
    }
    sites.push({
      file,
      line,
      childTag: childName,
      functionProps: functionTypedProps(ts, child),
    });
  });
  return { sites, errors, unattributed };
}

/** Reach into host plumbing inside the captured component's own module:
 *  next router imports and context/router-style hook calls. */
function plumbingSignals(source: string, file: string): string[] {
  const parsed = parseModuleSource(source, file);
  if (!parsed) return [];
  const { ts, sf } = parsed;
  const signals = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && PLUMBING_MODULE.test(statement.moduleSpecifier.text)) {
      signals.add(`imports ${statement.moduleSpecifier.text}`);
    }
  }
  visitNodes(ts, sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && PLUMBING_HOOK.test(node.expression.text)) {
      signals.add(`calls ${node.expression.text}()`);
    }
  });
  return [...signals];
}

async function readExisting(file: string): Promise<{ exists: boolean; baseline: SeedBaseline | null }> {
  try {
    const raw = await fs.readFile(file, "utf8");
    try {
      return { exists: true, baseline: seedBaselineSchema.parse(JSON.parse(raw)) };
    } catch {
      return { exists: true, baseline: null };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, baseline: null };
    throw error;
  }
}

async function captureRootStyles(
  root: string,
  realRoot: string,
  files: readonly string[],
  warnings: string[],
): Promise<SeedStyle[]> {
  const styles: SeedStyle[] = [];
  const seen = new Set<string>();
  for (const rootFile of files.filter((file) => ROOT_FILE.test(portablePath(root, file)))) {
    const source = await fs.readFile(rootFile, "utf8");
    for (const specifier of importSpecifiers(source, rootFile).filter((value) => /\.css$/iu.test(value))) {
      const resolved = await resolveImportSource(rootFile, specifier, root);
      if (resolved === null) {
        warnings.push(`host app root ${portablePath(root, rootFile)} stylesheet import ${specifier} could not be resolved`);
        continue;
      }
      let realFile: string;
      try {
        realFile = await fs.realpath(resolved.file);
      } catch {
        warnings.push(`host app root ${portablePath(root, rootFile)} stylesheet import ${specifier} could not be resolved safely`);
        continue;
      }
      if (!isInside(realRoot, realFile)) {
        warnings.push(`host app root ${portablePath(root, rootFile)} stylesheet import ${specifier} resolves outside the host root and was not captured`);
        continue;
      }
      if (seen.has(realFile)) continue;
      seen.add(realFile);
      const portable = portablePath(realRoot, realFile);
      // `.vendo/` is sync's OWN output, not host source. The root layout
      // imports `.vendo/fonts.css`, and capturing it back would copy ~65 KB of
      // base64 font into every seed on every run — a sheet Vendo emitted
      // reading itself in.
      if (portable.startsWith(".vendo/")) continue;
      styles.push({ path: portable, css: resolved.source });
    }
  }
  return styles;
}

function sameCapturedPayload(left: SeedBaseline | null, right: SeedBaseline): boolean {
  if (left === null) return false;
  const payload = (baseline: SeedBaseline) => ({
    slot: baseline.slot,
    source: baseline.source,
    hash: baseline.hash,
    exportable: baseline.exportable,
    sourceImports: baseline.sourceImports ?? {},
    subSources: baseline.subSources ?? {},
    sampleProps: baseline.sampleProps,
    styles: baseline.styles ?? [],
    ported: baseline.ported ?? null,
  });
  return JSON.stringify(payload(left)) === JSON.stringify(payload(right));
}

/** Resolve one wrapper's child through its import to the module that owns it.
 *  The slot is the child's exported identifier. Every failure is a loud error:
 *  runtime capture is gone, so there is nothing softer to degrade to. */
async function resolveSite(
  site: WrapperSite,
  source: string,
  root: string,
  realRoot: string,
  extraRoots: readonly string[],
  errors: string[],
): Promise<ResolvedSite | null> {
  // Walked files are labeled relative to the given root, not its realpath —
  // on a symlinked project directory the realpath-relative form is garbled.
  const at = `${portablePath(root, site.file)}:${site.line}`;
  const reference = await importReferenceFor(source, site.childTag);
  if (!reference) {
    errors.push(`${at} — <Remixable> wraps <${site.childTag}>, which is not statically imported; extract it into its own module, import it, and wrap the imported component`);
    return null;
  }
  const resolved = await resolveImportSource(site.file, reference.specifier, root, reference.imported, extraRoots);
  if (!resolved) {
    errors.push(`${at} — <Remixable> wraps <${site.childTag}>, but its import ("${reference.specifier}") does not resolve to source inside the host root`);
    return null;
  }
  let realFile: string;
  try {
    realFile = await fs.realpath(resolved.file);
  } catch {
    errors.push(`${at} — <Remixable> wraps <${site.childTag}>, but its source could not be read safely inside the host root`);
    return null;
  }
  if (!insideBounds([realRoot, ...extraRoots], realFile)) {
    errors.push(`${at} — <Remixable> wraps <${site.childTag}>, but its source resolves outside the host root`);
    return null;
  }
  // The slot is the exported identifier. A default import has none, and
  // keying by the call-site alias is FORBIDDEN (checker round-1 ruling
  // 2026-08-02: an alias-keyed slot dies on the next call-site refactor) —
  // the slot is the component's own declared name in its module.
  let slot = reference.imported;
  if (reference.imported === "default") {
    const declared = defaultExportName(resolved.source, realFile);
    if (declared === null) {
      errors.push(`${at} — <Remixable> wraps <${site.childTag}>, but its module's default export is anonymous; name your component so its remixes survive refactors`);
      return null;
    }
    slot = declared;
  }
  return { ...site, slot, realFile, source: resolved.source };
}

/** The declared name of a module's default export: `export default function
 *  Foo`, `export default class Foo`, `export default Foo`, or
 *  `export { Foo as default }`. Null when the default export is anonymous
 *  (or wrapped in an expression its author never named), and null when the
 *  module has no default export at all. */
function defaultExportName(source: string, file: string): string | null {
  return defaultExportOf(source, file)?.name ?? null;
}

/** The slot's PORTED half, spreadable into its baseline. One tier, and the
 *  gauntlet is the only judge: a slot that does not split gets no `ported`, no ✦
 *  and a loud line — while every other slot in this run still captures, still
 *  ports, and still ships. */
async function portFor(
  input: SplitInput,
  wiring: WiringSlot[],
  homes: Map<string, string>,
  warnings: string[],
): Promise<Pick<SeedBaseline, "ported">> {
  const split = await splitSlot(input);
  if (!split.ok) {
    // One issue per line: a real component fails the gauntlet a dozen ways at
    // once, and a dozen repair instructions joined by semicolons is a wall
    // nobody reads — which is the same as not reporting them.
    warnings.push([`remixable component ${input.slot} was not split, so it stays un-remixable (the rest of this sync is unaffected):`, ...split.issues].join("\n    "));
    return {};
  }
  wiring.push(split.wiring);
  if (split.home !== undefined) homes.set(input.slot, split.home);
  return { ported: split.port };
}

/** ONE wiring file per sync, covering every slot that split. Written whenever
 *  this host has a wrapper at all, so a run where the last port stops splitting
 *  empties it instead of leaving a binding nothing points at. */
async function writeWiring(directory: string, slots: readonly WiringSlot[], anyWrapper: boolean): Promise<void> {
  if (!anyWrapper) return;
  await writeIfChanged(path.join(directory, "remix-wiring.ts"), remixWiringSource(slots));
}

/** One home module per slot the carver cut — `remix-holes/<Slot>.tsx`, the
 *  files the wiring imports carved holes from. Regenerated whole, and a slot
 *  that stopped needing one loses its file, so nothing lingers for the wiring
 *  to dangle on. */
async function writeHoles(directory: string, homes: ReadonlyMap<string, string>): Promise<void> {
  const holesDir = path.join(directory, "remix-holes");
  for (const [slot, home] of homes) await writeIfChanged(path.join(holesDir, `${slot}.tsx`), home);
  let existing: string[] = [];
  try {
    existing = await fs.readdir(holesDir);
  } catch {
    return;
  }
  for (const entry of existing) {
    const slot = entry.replace(/\.tsx$/u, "");
    if (!homes.has(slot)) await fs.rm(path.join(holesDir, entry), { force: true });
  }
}

/** Wrapper collisions are legal — the same component wrapped in two places is
 *  ONE capture, many mount points — so sites group by slot before capture. */
async function collectResolvedSites(
  root: string,
  realRoot: string,
  extraRoots: readonly string[],
  files: readonly string[],
  result: PinCaptureResult,
): Promise<Map<string, ResolvedSite[]>> {
  const bySlot = new Map<string, ResolvedSite[]>();
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const { sites, errors, unattributed } = await wrapperSites(source, file, portablePath(root, file), { file, root, extraRoots });
    result.errors.push(...errors);
    result.unattributed.push(...unattributed);
    for (const site of sites) {
      const resolved = await resolveSite(site, source, root, realRoot, extraRoots, result.errors);
      if (resolved === null) continue;
      const grouped = bySlot.get(resolved.slot);
      if (grouped === undefined) bySlot.set(resolved.slot, [resolved]);
      else grouped.push(resolved);
    }
  }
  return bySlot;
}

/** Shared per-run state a single slot's capture reads and writes into. */
interface CaptureContext {
  root: string;
  realRoot: string;
  extraRoots: readonly string[];
  remixableDir: string;
  /** Realpathed — the split measures the wiring file's imports against it. */
  generatedDir: string;
  budgetBytes?: number;
  samplePropsFor?: (file: string, slot: string) => Record<string, Json> | undefined;
  ignoreSlots: ReadonlySet<string>;
  wiring: WiringSlot[];
  homes: Map<string, string>;
  result: PinCaptureResult;
}

/** One resolved slot's full capture: the collision, ignore-list, and
 *  safe-filename refusals, the plumbing-signal warning, the closure walk and
 *  split, and the baseline write (or the sameCapturedPayload no-op) — every
 *  early exit below is a place the original loop iteration moved on. */
async function captureSlot(slot: string, sites: readonly ResolvedSite[], ctx: CaptureContext): Promise<void> {
  const { root, realRoot, extraRoots, remixableDir, generatedDir, budgetBytes, samplePropsFor, ignoreSlots, wiring, homes, result } = ctx;
  const [primary] = sites as [ResolvedSite, ...ResolvedSite[]];
  // Two wrappers of the SAME component are one capture, many mount points
  // (legal). Two DIFFERENT components sharing an exported name would leave
  // one of them silently baseline-less, so ambiguity fails loudly instead.
  const conflicting = sites.filter((site) => site.realFile !== primary.realFile);
  if (conflicting.length > 0) {
    const modules = [...new Set(sites.map((site) => portablePath(realRoot, site.realFile)))];
    result.errors.push(`${portablePath(root, primary.file)}:${primary.line} — two different components both export "${slot}" (${modules.join(", ")}); rename one export so each remixable slot names one component`);
    return;
  }
  if (ignoreSlots.has(slot)) return;
  const baselineFile = path.resolve(remixableDir, `${slot}.json`);
  if (!isInside(remixableDir, baselineFile)) {
    result.errors.push(`${portablePath(root, primary.file)}:${primary.line} — remixable component name ${slot} is not a safe baseline filename; rename the component`);
    return;
  }
  // Every fork renders sandboxed, so host plumbing never crosses the boundary —
  // this warning is unconditional.
  const signals = [...new Set([
    ...plumbingSignals(primary.source, primary.realFile),
    ...sites.flatMap((site) => site.functionProps).map((name) => `receives the function-typed prop ${name}`),
  ])];
  if (signals.length > 0) {
    result.warnings.push(`remixable component ${slot} reaches into host plumbing (${signals.join("; ")}) — plumbing does not cross the fork boundary`);
  }
  const styles = result.styles;
  const walked = await captureClosure({
    root,
    realRoot,
    extraRoots,
    label: `remixable slot ${slot}`,
    primaryFile: primary.realFile,
    primarySource: primary.source,
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
    warnings: result.warnings,
  });
  if (!walked.ok) {
    // Never clobber: the previous baseline stays exactly as captured, so a
    // fork keeps rendering while the host trims the closure.
    result.warnings.push(overBudgetWarning(`remixable slot ${slot}`, walked.overBudget));
    return;
  }
  const { sourceImports, subSources } = walked.closure;
  const sampleProps = samplePropsFor?.(primary.realFile, slot);
  const ported = await portFor(
    {
      slot, source: primary.source, file: primary.realFile, root, generatedDir,
      ...(sampleProps === undefined ? {} : { sampleProps }),
    },
    wiring,
    homes,
    result.warnings,
  );
  if (ported.ported !== undefined) result.ported.push(slot);
  const hash = `sha256:${sha256Hex(primary.source)}`;
  const existing = await readExisting(baselineFile);
  const baseline: SeedBaseline = {
    slot,
    source: primary.source,
    hash,
    exportable: false,
    capturedAt: new Date().toISOString(),
    ...(Object.keys(sourceImports).length === 0 ? {} : { sourceImports }),
    ...(Object.keys(subSources).length === 0 ? {} : { subSources }),
    // On the baseline so the seed door grades the port with the SAME values
    // sync just did — two graders, one source of props.
    ...(sampleProps === undefined ? {} : { sampleProps }),
    ...(styles.length === 0 ? {} : { styles }),
    ...ported,
  };
  if (sameCapturedPayload(existing.baseline, baseline)) return;
  await fs.mkdir(path.dirname(baselineFile), { recursive: true });
  await fs.writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  (existing.exists ? result.drifted : result.captured).push(slot);
}

/** A baseline whose slot matches no discovered wrapper is a forkable zombie —
 *  delete it. A run with wrapper errors prunes nothing: an unresolvable
 *  wrapper's slot is unknowable, and deleting its baseline would turn a loud
 *  failure into silent data loss. A DEGRADED scan prunes nothing either — a
 *  missing host compiler parses every file to zero sites without one error,
 *  and a walk that hit its file cap may simply never have seen the wrapper.
 *  An UNATTRIBUTED wrapper counts the same way: a host that just moved its
 *  imports behind a shim sync cannot follow still has every wrapper it had
 *  yesterday, and pruning on that reading would delete the baselines their
 *  forks live on. */
async function pruneZombieBaselines(
  remixableDir: string,
  files: readonly string[],
  bySlot: ReadonlyMap<string, ResolvedSite[]>,
  ignoreSlots: ReadonlySet<string>,
  result: PinCaptureResult,
): Promise<void> {
  const scanTrusted = parseModuleSource("", "compiler-probe.tsx") !== null
    && files.length < MAX_SCAN_FILES;
  if (scanTrusted && result.errors.length === 0 && result.unattributed.length === 0) {
    const entries = await fs.readdir(remixableDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      const slot = entry.slice(0, -".json".length);
      if (bySlot.has(slot) || ignoreSlots.has(slot)) continue;
      await fs.rm(path.join(remixableDir, entry));
      result.pruned.push(slot);
    }
  }
}

export interface CapturePinsOptions {
  /** Slots the host opted out of (`.vendo/overrides.json` → `remix.ignoreSlots`). */
  ignoreSlots?: ReadonlySet<string>;
  /** Extra directories to scan for `<Remixable>` wrappers on top of the project
   *  root (`.vendo/overrides.json` → `remix.sources`). Resolved from the root,
   *  and free to sit OUTSIDE it: a repo whose app is `host/` and whose screens
   *  are `../demos/` needs both halves in one sync. */
  sources?: readonly string[];
  budgetBytes?: number;
  /** The host's own DECLARED sample props for a component, by (file, slot) —
   *  read off the catalog scan's registrations, never generated: a grade that
   *  passes on invented data is worse than a refusal. */
  samplePropsFor?: (file: string, slot: string) => Record<string, Json> | undefined;
}

const SOURCE_FILE = (relativePath: string): boolean =>
  /\.(?:[cm]?[jt]sx?)$/u.test(relativePath) && !/\.d\.ts$/u.test(relativePath);

/** The configured extra source roots, each one checked before it is trusted: a
 *  path that names nothing is a typo the host must SEE, not a directory that
 *  quietly contributes no wrappers. */
async function extraSourceRoots(
  root: string,
  sources: readonly string[],
  warnings: string[],
): Promise<{ scan: string[]; real: string[] }> {
  const scan: string[] = [];
  const real: string[] = [];
  for (const source of sources) {
    const directory = path.resolve(root, source);
    try {
      if (!(await fs.stat(directory)).isDirectory()) throw new Error("not a directory");
      real.push(await fs.realpath(directory));
      scan.push(directory);
    } catch {
      warnings.push(`remix source "${source}" is not a readable directory (looked in ${portablePath(root, directory)}), so no <Remixable> wrapper under it was scanned — fix the path in .vendo/overrides.json → remix.sources (it resolves from your project root), or drop the entry`);
    }
  }
  return { scan, real };
}

export async function capturePins(
  root: string,
  out: string,
  options: CapturePinsOptions = {},
): Promise<PinCaptureResult> {
  const { ignoreSlots = new Set<string>(), budgetBytes, samplePropsFor } = options;
  const result: PinCaptureResult = { captured: [], drifted: [], ported: [], pruned: [], errors: [], unattributed: [], warnings: [], styles: [] };
  const realRoot = await fs.realpath(root);
  const extra = await extraSourceRoots(root, options.sources ?? [], result.warnings);
  // One cap across every root, and one deduped list: an extra source that
  // overlaps the project root must not walk the same file twice.
  const walked: string[] = [];
  for (const directory of [root, ...extra.scan]) {
    if (walked.length >= MAX_SCAN_FILES) break;
    walked.push(...await walk(directory, SOURCE_FILE, MAX_SCAN_FILES - walked.length));
  }
  const files = [...new Set(walked)].sort();
  const remixableDir = path.join(out, "remixable");
  const generatedDir = path.join(out, "generated");
  // The wiring file's imports are relative paths, so both ends have to be
  // measured in the SAME space: resolveImportSource realpaths every module it
  // returns, and a project root reached through a symlink (a macOS temp dir, a
  // linked checkout) would otherwise emit an import that climbs out of the
  // project and bakes an absolute machine path into a file the host commits.
  const realGeneratedDir = path.join(realRoot, path.relative(root, generatedDir));
  const wiring: WiringSlot[] = [];
  const homes = new Map<string, string>();

  result.styles = await captureRootStyles(root, realRoot, files, result.warnings);

  const bySlot = await collectResolvedSites(root, realRoot, extra.real, files, result);

  const captureCtx: CaptureContext = {
    root, realRoot, extraRoots: extra.real, remixableDir, generatedDir: realGeneratedDir, budgetBytes, samplePropsFor, ignoreSlots, wiring, homes, result,
  };
  for (const [slot, sites] of [...bySlot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    await captureSlot(slot, sites, captureCtx);
  }

  await writeWiring(generatedDir, wiring, bySlot.size > 0);
  await writeHoles(generatedDir, homes);
  await pruneZombieBaselines(remixableDir, files, bySlot, ignoreSlots, result);

  result.captured.sort();
  result.drifted.sort();
  // Errors keep walk order: file order, then source position within a file
  // (a lexicographic sort would put page.tsx:10 before page.tsx:4).
  return result;
}
