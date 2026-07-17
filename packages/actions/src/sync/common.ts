import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { sha256Hex } from "@vendoai/core";
import type TS from "typescript";
import type { ExtractedTool, HttpMethod, PrimitiveToolBinding } from "../formats.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;
// Hidden directories are never route sources; alternate Next dist dirs
// (e.g. a test consumer's FIXTURE_DIST_DIR) must not leak compiled routes
// into extraction.
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const skipDir = (name: string): boolean => SKIP_DIRS.has(name) || name.startsWith(".");

interface TsconfigPathAlias {
  pattern: string;
  targets: string[];
}

export interface ResolvedSource {
  file: string;
  source: string;
}

export interface ImportReference {
  specifier: string;
  imported: string;
}

const aliasCache = new Map<string, Promise<TsconfigPathAlias[]>>();

/** Cleared at the start of every sync so a same-process re-run (watch mode) sees tsconfig edits. */
export function clearAliasCache(): void {
  aliasCache.clear();
}

export async function walk(
  root: string,
  keep: (relativePath: string) => boolean,
  maxFiles = 5_000,
): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir(entry.name)) await visit(full);
      } else if (keep(path.relative(root, full))) {
        files.push(full);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function extendsPath(value: unknown, configDir: string): string | null {
  if (typeof value !== "string" || (!value.startsWith(".") && !path.isAbsolute(value))) return null;
  const resolved = path.resolve(configDir, value);
  return path.extname(resolved) ? resolved : `${resolved}.json`;
}

async function loadAliases(configPath: string, depth = 0): Promise<TsconfigPathAlias[]> {
  // tsconfig files are JSONC; the compiler's own config parser reads them.
  const ts = loadCompiler();
  let parsed: any;
  try {
    parsed = ts?.parseConfigFileTextToJson(configPath, await fs.readFile(configPath, "utf8")).config;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const configDir = path.dirname(configPath);
  const aliases: TsconfigPathAlias[] = [];
  const extended = depth < 4 ? extendsPath(parsed?.extends, configDir) : null;
  if (extended) aliases.push(...await loadAliases(extended, depth + 1));
  const options = parsed?.compilerOptions && typeof parsed.compilerOptions === "object"
    ? parsed.compilerOptions
    : {};
  const baseUrl = path.resolve(configDir, typeof options.baseUrl === "string" ? options.baseUrl : ".");
  const paths = options.paths && typeof options.paths === "object" ? options.paths : {};
  for (const [pattern, rawTargets] of Object.entries(paths)) {
    if (!Array.isArray(rawTargets)) continue;
    const targets = rawTargets
      .filter((target): target is string => typeof target === "string")
      .map((target) => path.resolve(baseUrl, target));
    if (targets.length > 0) aliases.push({ pattern, targets });
  }
  return aliases;
}

function aliasesFor(root: string): Promise<TsconfigPathAlias[]> {
  const key = path.resolve(root);
  const cached = aliasCache.get(key);
  if (cached) return cached;
  const aliases = loadAliases(path.join(key, "tsconfig.json"));
  aliasCache.set(key, aliases);
  return aliases;
}

function aliasBases(specifier: string, alias: TsconfigPathAlias): string[] {
  const star = alias.pattern.indexOf("*");
  if (star === -1) return specifier === alias.pattern ? alias.targets : [];
  const prefix = alias.pattern.slice(0, star);
  const suffix = alias.pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];
  const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
  return alias.targets.map((target) => target.replace("*", matched));
}

function candidates(base: string): string[] {
  return [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvedCandidate(base: string, realRoot: string): Promise<ResolvedSource | null> {
  for (const candidate of candidates(base)) {
    if (candidate.split(path.sep).includes("node_modules")) continue;
    let realCandidate: string;
    try {
      realCandidate = await fs.realpath(candidate);
    } catch {
      continue;
    }
    if (!isInside(realRoot, realCandidate)) continue;
    try {
      return { file: realCandidate, source: await fs.readFile(realCandidate, "utf8") };
    } catch {
      // Try the next source-owned candidate.
    }
  }
  return null;
}

/** The TypeScript compiler, resolved lazily through this package's own
 * dependency graph (the same posture as catalog-scan). Module analysis is
 * fail-closed: when the compiler cannot be loaded, imports and exports
 * resolve to nothing rather than being guessed at with string scans. */
let compilerModule: typeof TS | null | undefined;

function loadCompiler(): typeof TS | null {
  if (compilerModule === undefined) {
    try {
      compilerModule = createRequire(import.meta.url)("typescript") as typeof TS;
    } catch {
      compilerModule = null;
    }
  }
  return compilerModule;
}

export interface ParsedModule {
  ts: typeof TS;
  sf: TS.SourceFile;
}

/** Parse one module's source for statement-level analysis (no type checking,
 * no host code execution). TSX is the default script kind — extraction mostly
 * reads component and route modules — with plain TS for `.ts`/`.mts`/`.cts`
 * files so generic arrows are not mis-lexed as JSX. */
export function parseModuleSource(source: string, fileName = "module.tsx"): ParsedModule | null {
  const ts = loadCompiler();
  if (!ts) return null;
  const kind = /\.[cm]?ts$/u.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  return { ts, sf: ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind) };
}

/** Depth-first visit of every node under `root` (root excluded). */
export function visitNodes(ts: typeof TS, root: TS.Node, visit: (node: TS.Node) => void): void {
  const walkNode = (node: TS.Node): void => {
    visit(node);
    ts.forEachChild(node, walkNode);
  };
  ts.forEachChild(root, walkNode);
}

function hasExportModifier(ts: typeof TS, statement: TS.Statement): boolean {
  return ts.canHaveModifiers(statement) === true
    && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(ts: typeof TS, statement: TS.Statement): boolean {
  return ts.canHaveModifiers(statement) === true
    && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function bindingDeclaresName(ts: typeof TS, name: TS.BindingName, exportedName: string): boolean {
  if (ts.isIdentifier(name)) return name.text === exportedName;
  return name.elements.some((element) =>
    !ts.isOmittedExpression(element) && bindingDeclaresName(ts, element.name, exportedName));
}

/** True when the module itself declares an export named `exportedName`
 * (declaration exports, `export default`, and specifier-only `export { x }`
 * lists — the local-value cases resolution treats as owned by this module). */
function declaresExport(ts: typeof TS, sf: TS.SourceFile, exportedName: string): boolean {
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement)) {
      if (exportedName === "default") return true;
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      if (statement.exportClause.elements.some((element) => element.name.text === exportedName)) return true;
      continue;
    }
    if (!hasExportModifier(ts, statement)) continue;
    if (hasDefaultModifier(ts, statement) && exportedName === "default") return true;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
      && statement.name?.text === exportedName) return true;
    if (ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) => bindingDeclaresName(ts, declaration.name, exportedName))) {
      return true;
    }
  }
  return false;
}

async function reExportTarget(source: string, exportedName: string, fileName?: string): Promise<{
  direct: boolean;
  named?: { specifier: string; imported: string };
  stars: string[];
}> {
  const parsed = parseModuleSource(source, fileName);
  if (!parsed) return { direct: false, stars: [] };
  const { ts, sf } = parsed;
  const stars: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.exportClause;
    if (!clause || ts.isNamespaceExport(clause)) {
      // `export * from` and `export * as ns from` both surface the target
      // module for name-by-name probing, matching the lexer-era behavior.
      stars.push(specifier);
      continue;
    }
    const element = clause.elements.find((item) => item.name.text === exportedName);
    if (element) {
      return {
        direct: false,
        named: { specifier, imported: (element.propertyName ?? element.name).text },
        stars,
      };
    }
  }
  return { direct: declaresExport(ts, sf, exportedName), stars };
}

async function importBases(importer: string, specifier: string, root: string): Promise<string[]> {
  const bases: string[] = [];
  if (specifier.startsWith(".")) bases.push(path.resolve(path.dirname(importer), specifier));
  else {
    // The host's own tsconfig paths are authoritative for every non-relative
    // specifier, including `@/` (most hosts map it to src/, not the root).
    for (const alias of await aliasesFor(root)) bases.push(...aliasBases(specifier, alias));
    // Convention fallback for `@/` when no tsconfig alias maps it.
    if (specifier.startsWith("@/")) bases.push(path.join(root, specifier.slice(2)));
  }
  return bases;
}

async function resolveImportedSource(
  importer: string,
  specifier: string,
  root: string,
  importedName: string,
  realRoot: string,
  seen: Set<string>,
): Promise<ResolvedSource | null> {
  const key = `${path.resolve(importer)}\0${specifier}\0${importedName}`;
  if (seen.has(key)) return null;
  seen.add(key);

  const bases = await importBases(importer, specifier, root);
  for (const base of bases) {
    const resolved = await resolvedCandidate(base, realRoot);
    if (!resolved) continue;
    const target = await reExportTarget(resolved.source, importedName, resolved.file);
    if (target.named) {
      // A named re-export is authoritative: when its chain cannot be followed
      // the export does not resolve, and returning the barrel here would
      // capture a false baseline that keeps sync green with unusable source.
      return await resolveImportedSource(
        resolved.file,
        target.named.specifier,
        root,
        target.named.imported,
        realRoot,
        seen,
      );
    }
    if (target.direct || importedName === "default") return resolved;
    for (const star of target.stars) {
      const followed = await resolveImportedSource(resolved.file, star, root, importedName, realRoot, seen);
      if (followed) return followed;
    }
    // The requested export is absent from everything this module reaches.
    // Fail loudly (unresolved pin + runtime-capture hint) over capturing a
    // file that does not own the component.
    return null;
  }
  return null;
}

export async function resolveImportSource(
  importer: string,
  specifier: string,
  root: string,
  importedName = "default",
): Promise<ResolvedSource | null> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return null;
  }
  return resolveImportedSource(importer, specifier, root, importedName, realRoot, new Set());
}

export async function importReferenceFor(source: string, localExpression: string): Promise<ImportReference | undefined> {
  const parsed = parseModuleSource(source);
  const [localName, namespaceMember] = localExpression.split(".", 2);
  if (!parsed || !localName) return undefined;
  const { ts, sf } = parsed;
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === localName && namespaceMember) {
      return { specifier, imported: namespaceMember };
    }
    if (namespaceMember !== undefined) continue;
    if (bindings && ts.isNamedImports(bindings)) {
      const element = bindings.elements.find((item) => item.name.text === localName);
      if (element) return { specifier, imported: (element.propertyName ?? element.name).text };
    }
    if (clause.name?.text === localName) return { specifier, imported: "default" };
  }
  return undefined;
}

export function limitToolName(fullName: string): string {
  return fullName.length <= 64 ? fullName : `${fullName.slice(0, 57)}_${sha256Hex(fullName).slice(0, 6)}`;
}

function routeSegments(urlPath: string): string[] {
  return urlPath.split("/").filter(Boolean);
}

function staticNameParts(urlPath: string): string[] {
  return routeSegments(urlPath)
    .filter((segment, index) => !(index === 0 && segment.toLowerCase() === "api"))
    .filter((segment) => !/^\{[^}]+\}$/.test(segment))
    .flatMap((segment) => segment.match(/[A-Za-z0-9]+/g) ?? [])
    .map((part) => part.toLowerCase());
}

export function routeToolFullName(method: HttpMethod, urlPath: string): string {
  const segments = routeSegments(urlPath);
  const last = segments.at(-1) ?? "";
  const endsInParameter = /^\{[^}]+\}$/.test(last);
  const hasEarlierParameter = segments.slice(0, -1).some((segment) => /^\{[^}]+\}$/.test(segment));
  const parts = staticNameParts(urlPath);
  const stem = `host_${parts.length > 0 ? parts.join("_") : "route"}`;
  if (method === "GET") return `${stem}${endsInParameter ? "_get" : "_list"}`;
  if (method === "POST") return hasEarlierParameter && !endsInParameter ? stem : `${stem}_create`;
  if (method === "PUT" || method === "PATCH") return `${stem}_update`;
  return `${stem}_delete`;
}

export function unclassifiedToolFullName(urlPath: string): string {
  const parts = staticNameParts(urlPath);
  return `host_${parts.length > 0 ? parts.join("_") : "route"}_unclassified`;
}

export function allocateToolName(preferred: string, fallbackSuffix: string, used: Set<string>): string {
  const first = limitToolName(preferred);
  if (!used.has(first)) {
    used.add(first);
    return first;
  }
  const methodFallback = limitToolName(`${preferred}_${fallbackSuffix.toLowerCase()}`);
  if (!used.has(methodFallback)) {
    used.add(methodFallback);
    return methodFallback;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = limitToolName(`${preferred}_${suffix}`);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export function dedupKey(method: HttpMethod, urlPath: string): string {
  return `${method} ${urlPath.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/g, "") || "/"}`;
}

/** The binding-kind-aware identity a tool is deduplicated and diffed by:
 * method+path for HTTP-shaped bindings, mount+procedure for tRPC (a host can
 * expose the same procedure name under two mounts — both tools must survive),
 * endpoint+operation for GraphQL, module+export for server actions. */
export function bindingIdentity(binding: PrimitiveToolBinding): string {
  if (binding.kind === "trpc") return `TRPC ${binding.mount.replace(/\/+$/g, "")} ${binding.procedure}`;
  // The operation kind joins the key: GraphQL allows a query and a mutation
  // to share one field name across the two root types.
  if (binding.kind === "graphql") return `GRAPHQL ${binding.endpoint.replace(/\/+$/g, "")} ${binding.type} ${binding.operation}`;
  if (binding.kind === "server-action") return `SERVER-ACTION ${binding.module}#${binding.exportName}`;
  return dedupKey(binding.method, binding.path);
}

function uniqueNameFallback(binding: PrimitiveToolBinding): string {
  if (binding.kind === "trpc" || binding.kind === "graphql") return binding.type;
  if (binding.kind === "server-action") return "action";
  return binding.method;
}

export function withUniqueNames(tools: ExtractedTool[]): ExtractedTool[] {
  const used = new Set<string>();
  return tools.map((tool) => ({
    ...tool,
    name: allocateToolName(tool.name, uniqueNameFallback(tool.binding), used),
  }));
}

const DESTRUCTIVE_WORDS = new Set([
  "delete", "remove", "destroy", "cancel", "close", "reset", "revoke", "purge", "wipe", "archive",
  "unpause", "transfer", "send", "invite",
]);
const READ_WORDS = new Set(["get", "list", "fetch", "search", "find", "read", "show", "query", "describe", "count"]);

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

function containsWord(value: string, vocabulary: ReadonlySet<string>): boolean {
  return words(value).some((word) => vocabulary.has(word));
}

export function extractedRisk(method: HttpMethod, name: string, source: "openapi" | "route"): ExtractedTool["risk"] {
  if (method === "DELETE" || containsWord(name, DESTRUCTIVE_WORDS)) return "destructive";
  if (source === "openapi" && method === "GET" && containsWord(name, READ_WORDS)) return "read";
  return "write";
}

/** tRPC risk labeling (04 §1, fail-closed): the destructive word list applies
 * unchanged; a query earns `read` only with a read-shaped name; everything
 * else — mutations and ambiguously-named queries — defaults to `write`. */
export function trpcRisk(type: "query" | "mutation", procedure: string): ExtractedTool["risk"] {
  if (containsWord(procedure, DESTRUCTIVE_WORDS)) return "destructive";
  if (type === "query" && containsWord(procedure, READ_WORDS)) return "read";
  return "write";
}

export function trpcToolFullName(procedure: string): string {
  const parts = words(procedure);
  return `host_${parts.length > 0 ? parts.join("_") : "procedure"}`;
}

/** GraphQL risk labeling (04 §1, fail-closed): identical semantics to tRPC —
 * the destructive word list applies unchanged; a query earns `read` only with
 * a read-shaped name; mutations and ambiguously-named queries default `write`. */
export function graphqlRisk(type: "query" | "mutation", operation: string): ExtractedTool["risk"] {
  return trpcRisk(type, operation);
}

export function graphqlToolFullName(operation: string): string {
  const parts = words(operation);
  return `host_${parts.length > 0 ? parts.join("_") : "operation"}`;
}

/** Server-action risk labeling (04 §1, fail-closed): the destructive word list
 * applies unchanged; everything else defaults to `write`. A read-shaped name
 * never earns `read` — a server action is a POST-shaped mutation surface and
 * static parsing cannot prove it reads only. */
export function serverActionRisk(name: string): ExtractedTool["risk"] {
  return containsWord(name, DESTRUCTIVE_WORDS) ? "destructive" : "write";
}

export function serverActionToolFullName(name: string): string {
  const parts = words(name);
  return `host_${parts.length > 0 ? parts.join("_") : "action"}`;
}
