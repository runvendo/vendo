import { promises as fs } from "node:fs";
import path from "node:path";
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
export const DEFAULT_CAPTURE_BUDGET_BYTES = 256 * 1024;

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const BLESSED_JAIL_MODULES = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);

export interface CapturedClosure {
  sourceImports: Record<string, string>;
  subSources: Record<string, CapturedPinSubSource>;
  /** Entry source plus every captured module, in UTF-8 bytes. */
  bytes: number;
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
      found.push({ at: statement.getStart(sf), specifier: statement.moduleSpecifier.text });
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
  const sourceImports: Record<string, string> = {};
  const captured = new Map<string, CapturedPinSubSource>();
  const sizes = new Map<string, number>();
  const primaryId = portablePath(realRoot, primaryFile);
  let bytes = Buffer.byteLength(primarySource, "utf8");
  sizes.set(primaryId, bytes);
  const queue: CaptureTask[] = [{ file: primaryFile, id: null, source: primarySource }];

  const largest = (): string => [...sizes.entries()]
    .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))[0]![0];

  while (queue.length > 0) {
    const task = queue.shift()!;
    const imports = task.id === null ? sourceImports : captured.get(task.id)!.imports;
    for (const specifier of importSpecifiers(task.source, task.file)) {
      if (BLESSED_JAIL_MODULES.has(specifier)) continue;
      const importer = task.id ?? primaryId;
      if (/\.css(?:$|\?)/iu.test(specifier)) {
        missed.push(`${label} missed import ${specifier} from ${importer} (component stylesheet imports are not captured; use an app-root stylesheet)`);
        continue;
      }
      // Package boundary: not the host's code, so not the host's capture.
      if (await isPackageSpecifier(task.file, specifier, root)) continue;
      const resolved = await resolveImportSource(task.file, specifier, root);
      if (resolved === null) {
        missed.push(`${label} missed import ${specifier} from ${importer} (could not be resolved)`);
        continue;
      }
      let realFile: string;
      try {
        realFile = await fs.realpath(resolved.file);
      } catch {
        missed.push(`${label} missed import ${specifier} from ${importer} (could not be resolved safely)`);
        continue;
      }
      if (!isInside(realRoot, realFile)) {
        missed.push(`${label} missed import ${specifier} from ${importer} (resolves outside the host root)`);
        continue;
      }
      if (!SOURCE_FILE.test(realFile)) {
        missed.push(`${label} missed import ${specifier} from ${importer} (not JavaScript/TypeScript source)`);
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
    },
  };
}

/** The one over-budget sentence: what blew it, and what to do about it. */
export function overBudgetWarning(label: string, over: ClosureOverBudget): string {
  const kb = (value: number): string => `${Math.round(value / 1024)} KB`;
  return `${label} was not captured: its import closure is ${kb(over.bytes)}, over the ${kb(over.budgetBytes)} per-component budget (largest: ${over.largest}) — split the component away from that module, or import it lazily, so the console can render it`;
}
