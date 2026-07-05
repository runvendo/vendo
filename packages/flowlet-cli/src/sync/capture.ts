/**
 * `flowlet sync` capture step (remix-fidelity epic): find every
 * `<FlowletRemix id="...">` in the app source, resolve the wrapped child
 * component's file, and capture its source verbatim into
 * `.flowlet/remix-sources.json`.
 *
 * Deterministic AST work only (TypeScript compiler API) — no LLM, no
 * network. Fail-open per anchor: anything unresolvable is omitted with a
 * report entry; the anchor keeps the DOM-snapshot baseline.
 *
 * Server-only refusal (threat model): only client-bundle code is capturable.
 * Files with a `"use server"` directive, under `server/`, `api/`,
 * `pages/api/`, or outside the app source root are refused.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { RemixSourceRecord } from "@flowlet/core";

export const SOURCE_CAP_BYTES = 48 * 1024;

export interface CaptureResult {
  records: Record<string, RemixSourceRecord>;
  /** Human report lines: what was captured, what was skipped and why. */
  report: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".flowlet", "out"]);
const SOURCE_EXTS = [".tsx", ".ts", ".jsx", ".js"];
const INDEX_BASENAMES = SOURCE_EXTS.map((ext) => `index${ext}`);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) yield* walk(full);
    else if (/\.(tsx|jsx)$/.test(entry)) yield full;
  }
}

/** tsconfig `paths` aliases (e.g. `@/*`), resolved against `baseUrl`. */
export function readAliases(targetDir: string): Array<{ prefix: string; to: string }> {
  const aliases: Array<{ prefix: string; to: string }> = [];
  try {
    const raw = readFileSync(path.join(targetDir, "tsconfig.json"), "utf8");
    const parsed = ts.parseConfigFileTextToJson("tsconfig.json", raw).config as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const base = path.resolve(targetDir, parsed.compilerOptions?.baseUrl ?? ".");
    for (const [pattern, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
      const target = targets[0];
      if (!pattern.endsWith("/*") || !target?.endsWith("/*")) continue;
      aliases.push({ prefix: pattern.slice(0, -1), to: path.resolve(base, target.slice(0, -1)) });
    }
  } catch {
    /* no tsconfig or unparsable — relative imports still work */
  }
  return aliases;
}

export function resolveModuleFile(
  specifier: string,
  fromFile: string,
  aliases: Array<{ prefix: string; to: string }>,
): string | undefined {
  let base: string | undefined;
  if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    const alias = aliases.find((a) => specifier.startsWith(a.prefix));
    if (alias) base = path.join(alias.to, specifier.slice(alias.prefix.length));
  }
  if (!base) return undefined; // bare package import — not an app file
  const candidates = [
    base,
    ...SOURCE_EXTS.map((ext) => base + ext),
    ...INDEX_BASENAMES.map((idx) => path.join(base, idx)),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** Threat-model refusal — evaluated on the RESOLVED path + content. */
export function refusalReason(file: string, content: string, sourceRoot: string): string | undefined {
  const rel = path.relative(sourceRoot, file);
  if (rel.startsWith("..")) return "outside the app source root";
  const segments = rel.split(path.sep);
  if (segments.includes("server")) return "under a server/ directory";
  if (segments.includes("api")) return "under an api/ directory";
  if (/^\s*(['"])use server\1/m.test(content)) return 'has a "use server" directive';
  return undefined;
}

interface FoundAnchor {
  anchorId: string;
  childComponent?: string;
  file: string;
}

/** All `<FlowletRemix id="...">` usages in one file (literal ids only). */
function findAnchors(sourceFile: ts.SourceFile): Array<FoundAnchor | { dynamic: true; file: string }> {
  const found: Array<FoundAnchor | { dynamic: true; file: string }> = [];

  const jsxTagName = (node: ts.JsxChild): string | undefined => {
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(sourceFile);
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(sourceFile);
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === "FlowletRemix") {
      const idAttr = node.openingElement.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sourceFile) === "id",
      );
      const init = idAttr?.initializer;
      if (!init || !ts.isStringLiteral(init)) {
        found.push({ dynamic: true, file: sourceFile.fileName });
      } else {
        // The wrapped child: the single top-level element child that names a
        // Component (uppercase). Anything else falls back to the enclosing file.
        const elementChildren = node.children.filter(
          (c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c),
        );
        const childName = elementChildren.length === 1 ? jsxTagName(elementChildren[0]!) : undefined;
        const isComponent = childName !== undefined && /^[A-Z]/.test(childName);
        found.push({
          anchorId: init.text,
          ...(isComponent ? { childComponent: childName } : {}),
          file: sourceFile.fileName,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The import that brings `name` into the file → { specifier, exportName }. */
function findImport(
  sourceFile: ts.SourceFile,
  name: string,
): { specifier: string; exportName?: string } | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    const specifier = statement.moduleSpecifier.text;
    if (clause.name?.text === name) return { specifier }; // default import
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.name.text === name) {
          return { specifier, exportName: (element.propertyName ?? element.name).text };
        }
      }
    }
  }
  return undefined;
}

export interface CaptureOptions {
  now?: () => string;
  /** App source root for the refusal check. Default: `<targetDir>/src` when it
   *  exists, else the targetDir. */
  sourceRoot?: string;
}

export function captureRemixSources(targetDir: string, opts: CaptureOptions = {}): CaptureResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const defaultRoot = path.join(targetDir, "src");
  const sourceRoot =
    opts.sourceRoot ??
    (() => {
      try {
        return statSync(defaultRoot).isDirectory() ? defaultRoot : targetDir;
      } catch {
        return targetDir;
      }
    })();
  const aliases = readAliases(targetDir);
  const records: Record<string, RemixSourceRecord> = {};
  const report: string[] = [];

  // flowlet.config.json remixAnchors: explicit anchor→file overrides for
  // cases the child heuristic gets wrong (e.g. the wrapper's direct child is
  // a generic ui primitive but the meaningful component is the enclosing
  // one). Overrides win; refusal rules still apply.
  const overrides = new Map<string, { file: string; exportName?: string }>();
  try {
    const raw = readFileSync(path.join(targetDir, "flowlet.config.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      remixAnchors?: Record<string, { file?: unknown; exportName?: unknown }>;
    };
    for (const [anchorId, entry] of Object.entries(parsed.remixAnchors ?? {})) {
      if (typeof entry?.file === "string") {
        overrides.set(anchorId, {
          file: entry.file,
          ...(typeof entry.exportName === "string" ? { exportName: entry.exportName } : {}),
        });
      } else {
        report.push(`skip override ${anchorId}: remixAnchors entries need a "file"`);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      report.push(`flowlet.config.json unreadable — overrides ignored (${(e as Error).message})`);
    }
  }

  const capture = (anchorId: string, file: string, exportName?: string): void => {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      report.push(`skip ${anchorId}: could not read ${file}`);
      return;
    }
    const refusal = refusalReason(file, content, sourceRoot);
    if (refusal) {
      report.push(`skip ${anchorId}: ${refusal} (${path.relative(targetDir, file)})`);
      return;
    }
    const capped =
      content.length > SOURCE_CAP_BYTES
        ? `${content.slice(0, SOURCE_CAP_BYTES)}\n[truncated]`
        : content;
    if (anchorId in records) report.push(`note ${anchorId}: multiple wrappers share this id — last capture wins`);
    records[anchorId] = {
      file: path.relative(targetDir, file),
      ...(exportName !== undefined ? { exportName } : {}),
      source: capped,
      sourceHash: createHash("sha256").update(content).digest("hex").slice(0, 16),
      capturedAt: now(),
    };
    report.push(`captured ${anchorId} ← ${path.relative(targetDir, file)}${exportName ? ` (${exportName})` : ""}`);
  };

  for (const [anchorId, override] of overrides) {
    capture(anchorId, path.resolve(targetDir, override.file), override.exportName);
    const captured = records[anchorId];
    if (captured) report[report.length - 1] += " (config override)";
  }

  for (const file of walk(targetDir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("FlowletRemix")) continue;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const anchor of findAnchors(sourceFile)) {
      if ("dynamic" in anchor) {
        report.push(`skip: dynamic FlowletRemix id in ${path.relative(targetDir, anchor.file)} — only literal ids are capturable`);
        continue;
      }
      if (overrides.has(anchor.anchorId)) continue; // config override won
      if (anchor.childComponent) {
        const imported = findImport(sourceFile, anchor.childComponent);
        const resolved = imported
          ? resolveModuleFile(imported.specifier, file, aliases)
          : undefined;
        if (resolved) {
          capture(anchor.anchorId, resolved, imported?.exportName);
          continue;
        }
        if (imported) {
          report.push(
            `note ${anchor.anchorId}: could not resolve "${imported.specifier}" — capturing the enclosing file instead`,
          );
        }
      }
      // Multi-child, inline markup, locally-defined, or unresolvable child:
      // the enclosing file IS the component context.
      capture(anchor.anchorId, file);
    }
  }

  if (Object.keys(records).length === 0) {
    report.push("no FlowletRemix wrappers captured (fine on a fresh install — wrap components, then re-run flowlet sync)");
  }
  return { records, report };
}
