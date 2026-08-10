import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isIslandResolvableSpecifier,
  isPinnedJailPackage,
  JAIL_BUNDLED_PACKAGES,
} from "@vendoai/apps/contract";
import type { CapturedPinSubSource } from "../formats.js";
import {
  isInside,
  isPackageSpecifier,
  parseModuleSource,
  resolveImportSource,
  visitNodes,
} from "./common.js";

/**
 * The one source-capture walk, shared by `<Remixable>` pin baselines and the
 * registered-component registry. It follows the host's own imports to CLOSURE —
 * there is no depth cap, because a helper three files down is exactly as
 * load-bearing as one file down — and is bounded instead by two honest limits:
 *
 *  - PACKAGE BOUNDARY. Anything that resolves into `node_modules` is never
 *    captured and never warned about: it is not the host's code, and the jail
 *    supplies the modules it blesses.
 *  - BYTE BUDGET. One total budget per captured component. Over it, the whole
 *    capture is skipped with a warning naming the module that blew it, so the
 *    console can say "too large to preview" instead of rendering a hole.
 */

/** ~1 MB of TypeScript is already far past what a jail should compile to draw
 *  one card; 256 KB leaves generous headroom for a real component tree while
 *  keeping a stray data fixture out of every host's `.vendo/`. */
const DEFAULT_CAPTURE_BUDGET_BYTES = 256 * 1024;

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;

export interface CapturedClosure {
  sourceImports: Record<string, string>;
  subSources: Record<string, CapturedPinSubSource>;
  /** Entry source plus every captured module, in UTF-8 bytes. */
  bytes: number;
  /**
   * Specifiers the jail will ask for and cannot answer: every import the walk
   * did NOT capture that is not `isIslandResolvableSpecifier` — unbundled
   * package imports, component-local stylesheets, unresolvable host paths.
   *
   * This is the difference between a closure that renders and one that
   * error-boxes. The jail compiles with sucrase's `imports` transform, so every
   * surviving import becomes `require(specifier)`; a specifier that is neither
   * in JAIL_MODULES nor in the module's captured import table THROWS
   * (`module "zod" is not available in the Vendo jail`), which the host catches
   * into a red "Generated component error" notice. Dropping these silently is
   * how a grey placeholder becomes a mislabeled crash.
   */
  unsupported: string[];
  /**
   * Every PACKAGE this closure needs at render time — the ones the jail runtime
   * bundles (core's JAIL_BUNDLED_PACKAGES) and the ones a preview venue can
   * fetch from the pinned CDN alike.
   *
   * Recorded so a CONSUMER can detect skew instead of failing silently: a jail
   * runtime that cannot supply one throws `module "recharts" is not available`,
   * and a surface that renders previews as `streaming` turns that throw into a
   * shimmer skeleton forever — no frame, no error, indistinguishable from
   * "still loading". A consumer that predates CDN loading sees `recharts` here,
   * finds it unsatisfied, and says so honestly instead of spinning.
   */
  requires: string[];
  /**
   * PREVIEW VENUE ONLY. Import specifier -> `<name>@<exact installed version>`
   * plus any subpath, for every package import a preview can resolve from the
   * pinned CDN (core's `JAIL_PACKAGE_CDN_ORIGIN`).
   *
   * Deliberately reported ALONGSIDE `unsupported` rather than removed from it:
   * the walk states facts, and the two venues that read a closure answer them
   * differently. A `<Remixable>` pin baseline renders in a customer's own page,
   * where no CDN may be reached, so `unsupported` stays exactly as it always
   * was for that caller; a console preview subtracts these (see
   * {@link previewBlockingSpecifiers}).
   */
  packages: Record<string, string>;
  /**
   * Package imports that are NOT offered to the CDN, with the clause that says
   * why — a workspace link or a `private: true` package is not on any public
   * registry, and a version we cannot resolve exactly must never be guessed.
   * The preview says this instead of shipping a URL that 404s.
   */
  unloadablePackages: Record<string, string>;
}

/** The specifiers that block a PREVIEW render: everything the jail cannot
 *  resolve, minus the packages a preview venue fetches from the pinned CDN. */
export const previewBlockingSpecifiers = (closure: CapturedClosure): string[] =>
  closure.unsupported.filter((specifier) => closure.packages[specifier] === undefined);

/** `@scope/name/sub/path` -> `{ name: "@scope/name", subpath: "/sub/path" }`. */
function splitPackageSpecifier(specifier: string): { name: string; subpath: string } | null {
  const parts = specifier.split("/");
  const segments = specifier.startsWith("@") ? 2 : 1;
  if (parts.length < segments || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return { name: parts.slice(0, segments).join("/"), subpath: parts.slice(segments).map((part) => `/${part}`).join("") };
}

/** The installed package's manifest, found the way Node finds it: the nearest
 *  `node_modules/<name>` walking up from the importer. */
async function installedManifest(importer: string, name: string): Promise<{ file: string; json: Record<string, unknown> } | null> {
  let directory = path.dirname(path.resolve(importer));
  for (;;) {
    const file = path.join(directory, "node_modules", name, "package.json");
    try {
      const real = await fs.realpath(file);
      return { file: real, json: JSON.parse(await fs.readFile(real, "utf8")) as Record<string, unknown> };
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
}

/**
 * The exact pin for one package import, or the reason there isn't one.
 *
 * The version comes from the manifest of the package the host actually has
 * INSTALLED — the same file Node reads to run their app, so a preview renders
 * the version their product renders. A lockfile would answer the same question
 * one step further from the truth (and in four incompatible formats).
 */
async function pinnedPackage(
  importer: string,
  specifier: string,
): Promise<{ pin: string } | { why: string }> {
  const split = splitPackageSpecifier(specifier);
  if (split === null) return { why: "it is not a resolvable package name" };
  const manifest = await installedManifest(importer, split.name);
  if (manifest === null) return { why: `${split.name} is not installed, so its exact version cannot be resolved` };
  // A registry install always lives UNDER a node_modules directory. A workspace
  // package or a `link:` dependency realpaths to plain source, which means it is
  // internal to the host and on no public registry.
  if (!manifest.file.split(path.sep).includes("node_modules")) {
    return { why: `${split.name} is a workspace package, so it is not on a public registry` };
  }
  if (manifest.json.private === true) return { why: `${split.name} is marked private, so it is not published` };
  const { version } = manifest.json;
  if (typeof version !== "string") return { why: `${split.name} declares no version, so it cannot be pinned` };
  const pin = `${split.name}@${version}${split.subpath}`;
  return isPinnedJailPackage(pin) ? { pin } : { why: `${split.name}@${version} is not an exact published version` };
}

export interface ClosureOverBudget {
  bytes: number;
  budgetBytes: number;
  /** Root-relative id of the largest module reached — what to shrink. */
  largest: string;
}

export type ClosureResult =
  | { ok: true; closure: CapturedClosure }
  | { ok: false; overBudget: ClosureOverBudget };

export function portablePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

export function importSpecifiers(source: string, fileName?: string): string[] {
  const parsed = parseModuleSource(source, fileName);
  if (!parsed) return [];
  const { ts, sf } = parsed;
  const found: Array<{ at: number; specifier: string }> = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.importClause?.isTypeOnly !== true) {
      // `import { type A, type B } from "x"` erases completely, exactly like
      // `import type`. A clause whose every named binding is inline-type (and
      // which binds no default or namespace) leaves no runtime import behind.
      const bindings = statement.importClause?.namedBindings;
      const allInlineType = statement.importClause !== undefined
        && statement.importClause.name === undefined
        && bindings !== undefined
        && ts.isNamedImports(bindings)
        && bindings.elements.length > 0
        && bindings.elements.every((element) => element.isTypeOnly);
      if (!allInlineType) found.push({ at: statement.getStart(sf), specifier: statement.moduleSpecifier.text });
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      && !statement.isTypeOnly) {
      found.push({ at: statement.getStart(sf), specifier: statement.moduleSpecifier.text });
    }
  }
  visitNodes(ts, sf, (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) found.push({ at: node.getStart(sf), specifier: argument.text });
    }
  });
  found.sort((left, right) => left.at - right.at || left.specifier.localeCompare(right.specifier));
  return [...new Set(found.map(({ specifier }) => specifier))];
}

/** The module's default export, when it has one: `name` is the identifier it
 *  declares, or null for an anonymous one. Null RESULT means no default export
 *  at all — a distinction the entry rule needs and `defaultExportName` (the
 *  pin path's caller) collapses. */
export function defaultExportOf(source: string, file: string): { name: string | null } | null {
  const parsed = parseModuleSource(source, file);
  if (!parsed) return null;
  const { ts, sf } = parsed;
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return { name: ts.isIdentifier(statement.expression) ? statement.expression.text : null };
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true) {
      return { name: statement.name?.text ?? null };
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined
      && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === "default") {
          return { name: element.propertyName === undefined ? null : element.propertyName.text };
        }
      }
    }
  }
  return null;
}

interface CaptureTask {
  file: string;
  id: string | null;
  source: string;
}

/**
 * Walk one component's import graph to closure. `label` names the thing being
 * captured in every warning ("remixable slot Foo", "host component Foo").
 * Warnings are only surfaced when the capture succeeds: an over-budget capture
 * reports the one fact that matters instead of a list of missed imports.
 */
export async function captureClosure(options: {
  root: string;
  realRoot: string;
  label: string;
  primaryFile: string;
  primarySource: string;
  budgetBytes?: number;
  warnings: string[];
}): Promise<ClosureResult> {
  const { root, realRoot, label, primaryFile, primarySource } = options;
  const budgetBytes = options.budgetBytes ?? DEFAULT_CAPTURE_BUDGET_BYTES;
  const missed: string[] = [];
  const unsupported = new Set<string>();
  const requires = new Set<string>();
  const packages: Record<string, string> = {};
  const unloadablePackages: Record<string, string> = {};
  const BUNDLED: ReadonlySet<string> = new Set(JAIL_BUNDLED_PACKAGES);
  const sourceImports: Record<string, string> = {};
  const captured = new Map<string, CapturedPinSubSource>();
  const sizes = new Map<string, number>();
  const primaryId = portablePath(realRoot, primaryFile);
  let bytes = Buffer.byteLength(primarySource, "utf8");
  sizes.set(primaryId, bytes);
  const queue: CaptureTask[] = [{ file: primaryFile, id: null, source: primarySource }];

  const largest = (): string => [...sizes.entries()]
    .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))[0]![0];

  // The budget is ONE total for the closure, and the entry file is already in
  // it. Checking only inside the walk lets an entry with no capturable
  // host-local import through at any size.
  if (bytes > budgetBytes) return { ok: false, overBudget: { bytes, budgetBytes, largest: largest() } };

  while (queue.length > 0) {
    const task = queue.shift()!;
    const imports = task.id === null ? sourceImports : captured.get(task.id)!.imports;
    for (const specifier of importSpecifiers(task.source, task.file)) {
      // Resolvable inside the jail without capture: react, the kit names, and
      // the packages the jail runtime bundles (core's JAIL_BUNDLED_PACKAGES).
      if (isIslandResolvableSpecifier(specifier)) {
        if (BUNDLED.has(specifier)) requires.add(specifier);
        continue;
      }
      const importer = task.id ?? primaryId;
      // Every path below leaves the specifier out of the import table, which
      // means the jail will ask for it and throw. Record it once, here.
      const drop = (why: string): void => {
        unsupported.add(specifier);
        missed.push(`${label} missed import ${specifier} from ${importer} (${why})`);
      };
      if (/\.css(?:$|\?)/iu.test(specifier)) {
        drop("component stylesheet imports are not captured; use an app-root stylesheet");
        continue;
      }
      // Package boundary: not the host's code, so not the host's capture. Its
      // exact installed version is recorded instead, so a PREVIEW venue can
      // fetch it from the pinned CDN; the specifier still counts as unsupported
      // for callers whose venue has no network at all (pin baselines).
      if (await isPackageSpecifier(task.file, specifier, root)) {
        unsupported.add(specifier);
        requires.add(specifier);
        const pinned = await pinnedPackage(task.file, specifier);
        if ("pin" in pinned) packages[specifier] = pinned.pin;
        else unloadablePackages[specifier] = pinned.why;
        continue;
      }
      const resolved = await resolveImportSource(task.file, specifier, root);
      if (resolved === null) {
        drop("could not be resolved");
        continue;
      }
      let realFile: string;
      try {
        realFile = await fs.realpath(resolved.file);
      } catch {
        drop("could not be resolved safely");
        continue;
      }
      if (!isInside(realRoot, realFile)) {
        drop("resolves outside the host root");
        continue;
      }
      if (!SOURCE_FILE.test(realFile)) {
        drop("not JavaScript/TypeScript source");
        continue;
      }
      const id = portablePath(realRoot, realFile);
      imports[specifier] = id;
      if (id === primaryId || captured.has(id)) continue;
      const size = Buffer.byteLength(resolved.source, "utf8");
      bytes += size;
      sizes.set(id, size);
      captured.set(id, { source: resolved.source, imports: {} });
      if (bytes > budgetBytes) return { ok: false, overBudget: { bytes, budgetBytes, largest: largest() } };
      queue.push({ file: realFile, id, source: resolved.source });
    }
  }

  options.warnings.push(...missed);
  const sorted = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
    Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
  return {
    ok: true,
    closure: {
      sourceImports: sorted(Object.entries(sourceImports)),
      subSources: sorted([...captured.entries()].map(([id, module]) => [id, {
        source: module.source,
        imports: sorted(Object.entries(module.imports)),
      }])),
      bytes,
      unsupported: [...unsupported].sort(),
      requires: [...requires].sort(),
      packages: sorted(Object.entries(packages)),
      unloadablePackages: sorted(Object.entries(unloadablePackages)),
    },
  };
}

/** The one over-budget sentence: what blew it, and what to do about it. */
export function overBudgetWarning(label: string, over: ClosureOverBudget): string {
  const kb = (value: number): string => `${Math.round(value / 1024)} KB`;
  return `${label} was not captured: its import closure is ${kb(over.bytes)}, over the ${kb(over.budgetBytes)} per-component budget (largest: ${over.largest}) — split the component away from that module, or import it lazily, so the console can render it`;
}
