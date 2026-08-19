import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex } from "@vendoai/core";
import {
  capturedHostComponentSchema,
  type CapturedHostComponent,
  type CapturedModule,
  type SeedStyle,
  type CatalogEntry,
  type HostComponentSampleGap,
  type HostComponentSkip,
} from "../formats.js";
import {
  captureClosure,
  defaultExportOf,
  overBudgetWarning,
  portablePath,
  previewBlockingSpecifiers,
  type CapturedClosure,
} from "./capture.js";
import { generateSampleProps } from "./sample-props.js";
import type { HostComponentSite } from "./catalog-scan.js";
import { isInside } from "./common.js";

/**
 * Source capture for the host's OWN registered components — everything mapped
 * in `<VendoProvider components={…}>`. Vendo used to store only their NAMES, so the
 * console's Apps gallery drew a grey labeled block where a real chart belongs.
 * Now the component's module (and its whole import closure) travels with the
 * name, and the console renders it in the same jail a generated component uses.
 *
 * The corpus is CONTENT-ADDRESSED. Ten components importing one
 * `format-currency.ts` store it once:
 *
 *   .vendo/components/<Name>.json           — refs only, ~400 bytes
 *   .vendo/components/modules/<hex>.json    — { source, imports? }, one per
 *                                             distinct module or stylesheet
 *
 * That split is the point, not an optimization: the index is small enough that
 * LISTING it is the hash manifest a Cloud push compares against, and the heavy
 * half is keyed by content, so a push can ask "which of these hashes do you
 * already have?" with one keys-only call (cli/cloud/host-components.ts).
 */

export const COMPONENTS_DIR = "components";
const MODULES_DIR = "modules";

export interface HostComponentCaptureResult {
  captured: string[];
  drifted: string[];
  /** Records deleted because the host no longer registers that component. */
  pruned: string[];
  /** Registered components left uncaptured this run (over budget, or with a
   *  module the entry rule cannot turn into a default export). */
  skipped: string[];
  /** Captured, but with neither usable `examples` nor a representable props
   *  schema — so a preview can only show a labeled placeholder. */
  withoutSamples: string[];
  warnings: string[];
}

/** The entry rule: which binding of the captured module the jail renders. */
function entryExport(
  source: string,
  file: string,
  binding: string,
): { export: string } | { skip: HostComponentSkip } {
  const declared = defaultExportOf(source, file);
  if (binding === "default") {
    return declared === null
      ? { skip: { reason: "no-default-export", detail: "Its module has no default export to render." } }
      : { export: "default" };
  }
  if (declared === null) return { export: binding };
  if (declared.name === binding) return { export: "default" };
  return {
    skip: {
      reason: "default-export-conflict",
      detail: `Its module already default-exports something else (${declared.name ?? "an anonymous value"}), so ${binding} cannot be given the default export the jail renders. Export ${binding} from its own module and register that.`,
    },
  };
}

/** The first declared example that parses to a JSON object of props. A
 *  malformed or non-object entry is stepped over rather than failing the
 *  component. */
export function declaredSample(examples: readonly string[] | undefined): Record<string, unknown> | null {
  for (const example of examples ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(example) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * The preview seed, resolved down a three-rung ladder:
 *
 *  1. The host's own `examples` — always preferred. A human's example reads
 *     better than anything synthesized, and it is real product data.
 *  2. Generated from the DECLARED `props:` schema. Most hosts never write
 *     examples but nearly all declare props, and sync already interprets those
 *     into JSON Schema for `catalog.json` — so a preview draws for essentially
 *     every registered component instead of only the documented few.
 *  3. Neither → an honest `noSampleProps` label, never a silent blank.
 *
 * The origin travels with the props (never INSIDE them — see the record field)
 * so a surface can say "generated sample data" rather than implying it is real.
 */
function sampleFrom(
  name: string,
  entry: Pick<CatalogEntry, "examples" | "propsSchema"> | undefined,
): { props: Record<string, unknown>; origin: "declared" | "generated" } | { gap: HostComponentSampleGap } {
  const declared = declaredSample(entry?.examples);
  if (declared !== null) return { props: declared, origin: "declared" };

  const generated = generateSampleProps(name, entry?.propsSchema);
  if (generated !== null) return { props: generated, origin: "generated" };

  const hasSchema = entry?.propsSchema !== undefined && Object.keys(entry.propsSchema).length > 0;
  const hasExamples = (entry?.examples ?? []).length > 0;
  if (hasSchema) {
    return {
      gap: {
        reason: "unrepresentable-props",
        detail: "Its declared props schema could not be turned into sample values, so a preview has no data to draw it with. Add an `examples` entry to its registration.",
      },
    };
  }
  return {
    gap: hasExamples
      ? {
        reason: "unreadable-examples",
        detail: "None of its declared examples parse as a JSON object of props, and it declares no props schema to generate from.",
      }
      : {
        reason: "no-examples",
        detail: "It declares neither examples nor a props schema, so a preview has no data to draw it with.",
      },
  };
}

/** The content address of one captured module: sha-256 hex over its canonical
 *  JSON, so two components that reach the same file agree on one key. */
function moduleRef(module: CapturedModule): string {
  return sha256Hex(canonicalJson(module));
}

interface Corpus {
  modules: Map<string, CapturedModule>;
}

function addModule(corpus: Corpus, module: CapturedModule): string {
  const ref = moduleRef(module);
  if (!corpus.modules.has(ref)) corpus.modules.set(ref, module);
  return ref;
}

async function readRecord(file: string): Promise<CapturedHostComponent | null> {
  try {
    return capturedHostComponentSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

/** Everything but `capturedAt`, which must not churn a committed artifact when
 *  nothing about the capture changed. */
function captureHash(record: Omit<CapturedHostComponent, "hash" | "capturedAt">): string {
  return `sha256:${sha256Hex(canonicalJson(record as unknown as Record<string, unknown>))}`;
}

/** The closure state one capture run shares across every component it visits. */
interface CaptureContext {
  root: string;
  realRoot: string;
  styles: readonly SeedStyle[];
  styleRefs: () => Array<{ path: string; ref: string }>;
  budgetBytes: number | undefined;
  corpus: Corpus;
  catalogByName: Map<string, CatalogEntry>;
  result: HostComponentCaptureResult;
}

/** One discovered component's source, read off disk. */
interface FoundComponent {
  label: string;
  realFile: string;
  source: string;
  /** The component's own module path, portable relative to the project root. */
  module: string;
}

/** The record a component whose whole import closure captured cleanly earns. */
function capturedRecord(
  ctx: CaptureContext,
  site: HostComponentSite,
  found: FoundComponent,
  entryExportName: string,
  closure: CapturedClosure,
): Omit<CapturedHostComponent, "hash" | "capturedAt"> {
  const { sourceImports, subSources, bytes, requires, packages } = closure;
  const modules: Record<string, string> = {};
  for (const [id, sub] of Object.entries(subSources)) {
    modules[id] = addModule(ctx.corpus, {
      source: sub.source,
      ...(Object.keys(sub.imports).length === 0 ? {} : { imports: sub.imports }),
    });
  }
  const sample = sampleFrom(site.name, ctx.catalogByName.get(site.name));
  if ("gap" in sample) ctx.result.withoutSamples.push(site.name);
  return {
    name: site.name,
    module: found.module,
    ...(entryExportName === "default" ? {} : { export: entryExportName }),
    entry: addModule(ctx.corpus, {
      source: found.source,
      ...(Object.keys(sourceImports).length === 0 ? {} : { imports: sourceImports }),
    }),
    ...(Object.keys(modules).length === 0 ? {} : { modules }),
    ...(ctx.styles.length === 0 ? {} : { styles: ctx.styleRefs() }),
    bytes,
    ...(requires.length === 0 ? {} : { requires }),
    ...(Object.keys(packages).length === 0 ? {} : { packages }),
    ...("gap" in sample
      ? { noSampleProps: sample.gap }
      : { sampleProps: sample.props, sampleOrigin: sample.origin }),
  };
}

/** The record one discovered component earns: its capture, or the reason — always
 *  a property of the SOURCE, never a transient failure — it has none. */
async function recordFor(
  ctx: CaptureContext,
  site: HostComponentSite,
  found: FoundComponent,
): Promise<Omit<CapturedHostComponent, "hash" | "capturedAt">> {
  /** Record the reason on disk so the console can say WHY, not just show a
   *  grey block. Only reached when the reason is a property of the SOURCE,
   *  never for a transient failure. */
  const skip = (reason: HostComponentSkip): Omit<CapturedHostComponent, "hash" | "capturedAt"> => {
    ctx.result.warnings.push(`${found.label} was not captured: ${reason.detail}`);
    ctx.result.skipped.push(site.name);
    return { name: site.name, module: found.module, skipped: reason };
  };

  if (site.binding === null) {
    return skip({
      reason: "no-named-declaration",
      detail: "It has no named declaration to re-export. Name the component (or export it) so it can be rendered.",
    });
  }
  if (!isInside(ctx.realRoot, found.realFile) || found.realFile.split(path.sep).includes("node_modules")) {
    return skip({
      reason: "in-package",
      detail: "It is declared inside a package, not in your source, so its code is not yours to capture.",
    });
  }
  const entry = entryExport(found.source, found.realFile, site.binding);
  if ("skip" in entry) return skip(entry.skip);

  const walked = await captureClosure({
    root: ctx.root,
    realRoot: ctx.realRoot,
    label: found.label,
    primaryFile: found.realFile,
    primarySource: found.source,
    ...(ctx.budgetBytes === undefined ? {} : { budgetBytes: ctx.budgetBytes }),
    warnings: ctx.result.warnings,
  });
  if (!walked.ok) {
    ctx.result.warnings.push(overBudgetWarning(found.label, walked.overBudget));
    ctx.result.skipped.push(site.name);
    return {
      name: site.name,
      module: found.module,
      skipped: {
        reason: "too-large",
        detail: `Its import closure is ${Math.round(walked.overBudget.bytes / 1024)} KB, over the ${Math.round(walked.overBudget.budgetBytes / 1024)} KB per-component budget (largest: ${walked.overBudget.largest}).`,
        bytes: walked.overBudget.bytes,
        budgetBytes: walked.overBudget.budgetBytes,
        largest: walked.overBudget.largest,
      },
    };
  }
  const blocking = previewBlockingSpecifiers(walked.closure);
  if (blocking.length > 0) {
    // The closure would LOAD as a crash. A named "cannot preview" tile
    // beats a red error box mislabeled as a generated-component
    // failure, which is what shipping this capture would produce. A
    // package the preview CAN fetch from the pinned CDN is not blocking
    // — one it cannot says so in its own clause.
    const named = blocking.map((value) => {
      const why = walked.closure.unloadablePackages[value];
      return why === undefined ? `"${value}"` : `"${value}" (${why})`;
    });
    return skip({
      reason: "unsupported-imports",
      detail: `It imports ${named.join(", ")}, which the sandboxed preview cannot load.`,
      specifiers: blocking,
    });
  }
  return capturedRecord(ctx, site, found, entry.export, walked.closure);
}

/**
 * Capture every registered component's source into `.vendo/components/`.
 * `styles` are the app-root stylesheets the pin capture already collected —
 * shared by every component, so they enter the corpus once.
 */
export async function captureHostComponents(options: {
  root: string;
  out: string;
  sites: readonly HostComponentSite[];
  styles: readonly SeedStyle[];
  /** The catalog sync just wrote — the source of the preview seed, via its
   *  `examples` then its derived `propsSchema`. The MERGED file, not the raw
   *  scan, so curated copy on a scanned entry counts exactly like a
   *  registry-declared one. */
  catalog?: readonly CatalogEntry[];
  /** A degraded catalog scan prunes nothing: it never saw the whole project. */
  degraded: boolean;
  budgetBytes?: number;
}): Promise<HostComponentCaptureResult> {
  const { root, out, sites, styles, degraded } = options;
  const result: HostComponentCaptureResult = { captured: [], drifted: [], pruned: [], skipped: [], withoutSamples: [], warnings: [] };
  const catalogByName = new Map((options.catalog ?? []).map((entry) => [entry.name, entry]));
  const dir = path.join(out, COMPONENTS_DIR);
  const modulesDir = path.join(dir, MODULES_DIR);
  const realRoot = await fs.realpath(root);
  const corpus: Corpus = { modules: new Map() };
  // Lazy: a project with no registered components must not write (and then
  // prune) a stylesheet blob nothing references.
  let styleRefsMemo: Array<{ path: string; ref: string }> | undefined;
  const styleRefs = (): Array<{ path: string; ref: string }> => styleRefsMemo ??= styles.map((style) => ({
    path: style.path,
    ref: addModule(corpus, { source: style.css }),
  }));
  const ctx: CaptureContext = {
    root,
    realRoot,
    styles,
    styleRefs,
    budgetBytes: options.budgetBytes,
    corpus,
    catalogByName,
    result,
  };
  /** Every component the scan DISCOVERED, capture succeeded or not. Prune runs
   *  against this, never against "what we managed to write": a transient
   *  unreadable file must not delete a good record here and its row in Cloud
   *  on the next push. (The pin capture has always pruned against discovery;
   *  this is that rule, inherited properly.) */
  const seen = new Set<string>();

  for (const site of [...sites].sort((left, right) => left.name.localeCompare(right.name))) {
    const label = `host component ${site.name}`;
    const recordFile = path.resolve(dir, `${site.name}.json`);
    if (!isInside(dir, recordFile)) {
      result.warnings.push(`${label} is not a safe artifact filename; rename the component`);
      continue;
    }
    seen.add(site.name);
    let realFile: string;
    let source: string;
    try {
      // realpath BEFORE anything derives from the path: on a symlinked temp or
      // project directory (/var -> /private/var) the raw path is not
      // root-relative and `module` would come out as a ../../.. escape.
      realFile = await fs.realpath(site.file);
      source = await fs.readFile(realFile, "utf8");
    } catch {
      // TRANSIENT, not a property of the source: write nothing, so an existing
      // good capture survives an unlucky read. `seen` above already protects
      // it from the prune (and so from a delete on the next Cloud push).
      result.warnings.push(`${label} could not be read this run; its previous capture was left untouched`);
      result.skipped.push(site.name);
      continue;
    }
    const module = portablePath(realRoot, realFile);
    const record = await recordFor(ctx, site, { label, realFile, source, module });

    const hash = captureHash(record);
    const existing = await readRecord(recordFile);
    if (existing?.hash === hash) continue;
    const complete: CapturedHostComponent = { ...record, hash, capturedAt: new Date().toISOString() };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(recordFile, `${JSON.stringify(sortRecord(complete), null, 2)}\n`, "utf8");
    // A skipped component's record lands (the console needs the reason) but is
    // reported only as skipped — it captured nothing.
    if (record.skipped === undefined) (existing === null ? result.captured : result.drifted).push(site.name);
  }

  // Write the corpus before pruning it, so a shared module a still-referenced
  // record needs is never briefly absent.
  await writeCorpus(modulesDir, corpus);
  if (!degraded) await prune(dir, modulesDir, seen, result);
  result.captured.sort();
  result.drifted.sort();
  result.skipped.sort();
  result.withoutSamples.sort();
  return result;
}

/** Field order a human reads first: identity, then where it came from, then refs. */
function sortRecord(record: CapturedHostComponent): CapturedHostComponent {
  const { name, hash, capturedAt, module, ...rest } = record;
  return { name, hash, capturedAt, module, ...rest };
}

async function writeCorpus(modulesDir: string, corpus: Corpus): Promise<void> {
  if (corpus.modules.size === 0) return;
  await fs.mkdir(modulesDir, { recursive: true });
  for (const [ref, module] of corpus.modules) {
    const file = path.join(modulesDir, `${ref}.json`);
    // Content-addressed: an existing file with this name already holds these
    // exact bytes, so writing it again would only churn mtimes.
    try {
      await fs.access(file);
      continue;
    } catch {
      await fs.writeFile(file, `${JSON.stringify(module, null, 2)}\n`, "utf8");
    }
  }
}

/**
 * Delete records the host no longer registers, then the modules nothing points
 * at. The reference set is read back off DISK — including records this run left
 * untouched — so a shared module survives as long as any record still names it.
 */
async function prune(
  dir: string,
  modulesDir: string,
  seen: ReadonlySet<string>,
  result: HostComponentCaptureResult,
): Promise<void> {
  const entries = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const name = entry.slice(0, -".json".length);
    if (seen.has(name)) continue;
    await fs.rm(path.join(dir, entry));
    result.pruned.push(name);
  }
  const referenced = new Set<string>();
  for (const name of [...seen].sort()) {
    const record = await readRecord(path.join(dir, `${name}.json`));
    if (record === null) continue;
    if (record.entry !== undefined) referenced.add(record.entry);
    for (const ref of Object.values(record.modules ?? {})) referenced.add(ref);
    for (const style of record.styles ?? []) referenced.add(style.ref);
  }
  const modules = await fs.readdir(modulesDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of modules.filter((name) => name.endsWith(".json")).sort()) {
    if (referenced.has(entry.slice(0, -".json".length))) continue;
    await fs.rm(path.join(modulesDir, entry));
  }
}
