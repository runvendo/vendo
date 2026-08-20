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
  importReferenceFor,
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
  warnings: string[];
  /** The app-root stylesheets this walk captured. Shared with the registered
   *  component capture — the same root files, read once. */
  styles: SeedStyle[];
}

/** One `<Remixable>` element found in host source. */
interface WrapperSite {
  file: string;
  line: number;
  review: boolean;
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
 *  (aliased or not — `import { Remixable as Remix }`) and namespace imports
 *  from a REMIXABLE_MODULE. A same-named component from anywhere else is not
 *  ours and is skipped silently (checker round-1 ruling 2026-08-02). */
interface RemixableBindings {
  names: Set<string>;
  namespaces: Set<string>;
}

function remixableBindings(ts: typeof TS, sf: TS.SourceFile): RemixableBindings {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !REMIXABLE_MODULE.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === "Remixable") names.add(element.name.text);
    }
  }
  return { names, namespaces };
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

function reviewFlag(ts: typeof TS, attributes: TS.JsxAttributes): boolean {
  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name) || property.name.text !== "review") continue;
    const initializer = property.initializer;
    if (initializer === undefined) return true; // <Remixable review>
    return ts.isJsxExpression(initializer) && initializer.expression?.kind === ts.SyntaxKind.TrueKeyword;
  }
  return false;
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

/** Every `<Remixable>` usage in one module, with loud errors for children that
 *  are not a single component element. */
function wrapperSites(
  source: string,
  file: string,
  relativeFile: string,
): { sites: WrapperSite[]; errors: string[] } {
  const sites: WrapperSite[] = [];
  const errors: string[] = [];
  // The token's absence is a cheap skip that avoids parsing every walked module.
  if (!source.includes("Remixable")) return { sites, errors };
  const parsed = parseModuleSource(source, file);
  if (!parsed) return { sites, errors };
  const { ts, sf } = parsed;
  const bindings = remixableBindings(ts, sf);
  if (bindings.names.size === 0 && bindings.namespaces.size === 0) return { sites, errors };
  visitNodes(ts, sf, (node) => {
    if (ts.isJsxSelfClosingElement(node) && isRemixableTag(ts, node.tagName, sf, bindings)) {
      errors.push(`${relativeFile}:${lineOf(sf, node)} — <Remixable /> wraps nothing; put exactly one component element inside it`);
      return;
    }
    if (!ts.isJsxElement(node) || !isRemixableTag(ts, node.openingElement.tagName, sf, bindings)) return;
    const line = lineOf(sf, node);
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
      review: reviewFlag(ts, node.openingElement.attributes),
      childTag: childName,
      functionProps: functionTypedProps(ts, child),
    });
  });
  return { sites, errors };
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
    review: baseline.review === true,
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
  const resolved = await resolveImportSource(site.file, reference.specifier, root, reference.imported);
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
  if (!isInside(realRoot, realFile)) {
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
  files: readonly string[],
  result: PinCaptureResult,
): Promise<Map<string, ResolvedSite[]>> {
  const bySlot = new Map<string, ResolvedSite[]>();
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const { sites, errors } = wrapperSites(source, file, portablePath(root, file));
    result.errors.push(...errors);
    for (const site of sites) {
      const resolved = await resolveSite(site, source, root, realRoot, result.errors);
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
  remixableDir: string;
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
  const { root, realRoot, remixableDir, generatedDir, budgetBytes, samplePropsFor, ignoreSlots, wiring, homes, result } = ctx;
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
  const review = sites.some((site) => site.review);
  if (review && sites.some((site) => !site.review)) {
    result.warnings.push(`remixable component ${slot} is wrapped both with and without review; capturing review: true`);
  }
  const baselineFile = path.resolve(remixableDir, `${slot}.json`);
  if (!isInside(remixableDir, baselineFile)) {
    result.errors.push(`${portablePath(root, primary.file)}:${primary.line} — remixable component name ${slot} is not a safe baseline filename; rename the component`);
    return;
  }
  if (!review) {
    const signals = [...new Set([
      ...plumbingSignals(primary.source, primary.realFile),
      ...sites.flatMap((site) => site.functionProps).map((name) => `receives the function-typed prop ${name}`),
    ])];
    if (signals.length > 0) {
      result.warnings.push(`remixable component ${slot} reaches into host plumbing (${signals.join("; ")}) — plumbing does not cross the fork boundary; consider <Remixable review> so approved remixes run natively in the page`);
    }
  }
  const styles = result.styles;
  const walked = await captureClosure({
    root,
    realRoot,
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
    ...(review ? { review: true } : {}),
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
 *  and a walk that hit its file cap may simply never have seen the wrapper. */
async function pruneZombieBaselines(
  remixableDir: string,
  files: readonly string[],
  bySlot: ReadonlyMap<string, ResolvedSite[]>,
  ignoreSlots: ReadonlySet<string>,
  result: PinCaptureResult,
): Promise<void> {
  const scanTrusted = parseModuleSource("", "compiler-probe.tsx") !== null
    && files.length < MAX_SCAN_FILES;
  if (scanTrusted && result.errors.length === 0) {
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

export async function capturePins(
  root: string,
  out: string,
  ignoreSlots: ReadonlySet<string> = new Set(),
  budgetBytes?: number,
  /** The host's own DECLARED sample props for a component, by (file, slot) —
   *  read off the catalog scan's registrations, never generated: a grade that
   *  passes on invented data is worse than a refusal. */
  samplePropsFor?: (file: string, slot: string) => Record<string, Json> | undefined,
): Promise<PinCaptureResult> {
  const result: PinCaptureResult = { captured: [], drifted: [], ported: [], pruned: [], errors: [], warnings: [], styles: [] };
  const realRoot = await fs.realpath(root);
  const files = await walk(root, (relativePath) => /\.(?:[cm]?[jt]sx?)$/u.test(relativePath) && !/\.d\.ts$/u.test(relativePath), MAX_SCAN_FILES);
  const remixableDir = path.join(out, "remixable");
  const generatedDir = path.join(out, "generated");
  const wiring: WiringSlot[] = [];
  const homes = new Map<string, string>();

  result.styles = await captureRootStyles(root, realRoot, files, result.warnings);

  const bySlot = await collectResolvedSites(root, realRoot, files, result);

  const captureCtx: CaptureContext = {
    root, realRoot, remixableDir, generatedDir, budgetBytes, samplePropsFor, ignoreSlots, wiring, homes, result,
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
