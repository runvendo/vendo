import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@vendoai/core";
import { init, parse } from "es-module-lexer";
import type { ExtractedTool, HttpMethod } from "../formats.js";

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

export function stripComments(source: string): string {
  let output = "";
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) output += "  ";
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function parseJsonLike(source: string): unknown {
  return JSON.parse(stripComments(source).replace(/,\s*([}\]])/g, "$1"));
}

function extendsPath(value: unknown, configDir: string): string | null {
  if (typeof value !== "string" || (!value.startsWith(".") && !path.isAbsolute(value))) return null;
  const resolved = path.resolve(configDir, value);
  return path.extname(resolved) ? resolved : `${resolved}.json`;
}

async function loadAliases(configPath: string, depth = 0): Promise<TsconfigPathAlias[]> {
  let parsed: any;
  try {
    parsed = parseJsonLike(await fs.readFile(configPath, "utf8"));
  } catch {
    return [];
  }
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

function namedBindings(statement: string): Array<{ imported: string; exported: string }> {
  const body = statement.match(/\{([\s\S]*?)\}/)?.[1];
  if (body === undefined) return [];
  return body.split(",").flatMap((raw) => {
    const part = raw.trim().replace(/^type\s+/, "");
    if (part === "") return [];
    const pieces = part.split(/\s+as\s+/).map((value) => value.trim());
    const imported = pieces[0];
    const exported = pieces[1] ?? imported;
    return imported && exported ? [{ imported, exported }] : [];
  });
}

interface ModuleImport {
  statement: string;
  specifier: string;
}

function fallbackModuleStatements(source: string): string[] {
  const statements: string[] = [];
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    const keyword = source.startsWith("import", index) ? "import"
      : source.startsWith("export", index) ? "export"
      : undefined;
    if (!keyword || /[\w$]/.test(source[index - 1] ?? "") || /[\w$]/.test(source[index + keyword.length] ?? "")) continue;

    let localDepth = 0;
    let localQuote: "'" | "\"" | "`" | null = null;
    let localEscaped = false;
    let end = source.length;
    for (let cursor = index; cursor < source.length; cursor += 1) {
      const value = source[cursor]!;
      if (localQuote) {
        if (localEscaped) localEscaped = false;
        else if (value === "\\") localEscaped = true;
        else if (value === localQuote) localQuote = null;
        continue;
      }
      if (value === "'" || value === "\"" || value === "`") {
        localQuote = value;
        continue;
      }
      if (value === "{" || value === "(" || value === "[") localDepth += 1;
      else if (value === "}" || value === ")" || value === "]") localDepth = Math.max(0, localDepth - 1);
      if (value === ";" && localDepth === 0) {
        end = cursor;
        break;
      }
      if (value === "\n" && localDepth === 0) {
        const candidate = source.slice(index, cursor);
        if (/\bfrom\s*["'][^"']+["']/.test(candidate)
            || /^import\s*["'][^"']+["']/.test(candidate)
            || /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/.test(candidate)) {
          end = cursor;
          break;
        }
        // Semicolon-free sources: a balanced newline followed by a fresh
        // import/export keyword always ends the current statement — otherwise
        // `export interface X { … }` swallows every later export in the file.
        if (/^\s*(?:import|export)[\s{"'(]/.test(source.slice(cursor + 1, cursor + 64))) {
          end = cursor;
          break;
        }
      }
    }
    statements.push(source.slice(index, end).trim());
    index = end;
  }
  return statements;
}

async function lexModule(source: string): Promise<{ imports: ModuleImport[]; exports: Set<string> }> {
  await init;
  try {
    const [imports, exports] = parse(source);
    return {
      imports: imports.flatMap((item) => item.d === -1 && item.n !== undefined
        ? [{ statement: source.slice(item.ss, item.se).trim(), specifier: item.n }]
        : []),
      exports: new Set(exports.map((item) => item.n)),
    };
  } catch {
    const statements = fallbackModuleStatements(source);
    const imports = statements.flatMap((statement) => {
      const specifier = statement.match(/\bfrom\s*["']([^"']+)["']/)?.[1]
        ?? statement.match(/^import\s*["']([^"']+)["']/)?.[1];
      return specifier ? [{ statement, specifier }] : [];
    });
    const exports = new Set<string>();
    for (const statement of statements) {
      const declaration = statement.match(/^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/)?.[1];
      if (declaration) exports.add(declaration);
      if (/^export\s+default\b/.test(statement)) exports.add("default");
      if (/^export\s*\{/.test(statement)) {
        for (const binding of namedBindings(statement)) exports.add(binding.exported);
      }
    }
    return { imports, exports };
  }
}

async function reExportTarget(source: string, exportedName: string): Promise<{
  direct: boolean;
  named?: { specifier: string; imported: string };
  stars: string[];
}> {
  const module = await lexModule(source);
  const stars: string[] = [];
  for (const imported of module.imports) {
    const statement = imported.statement;
    if (!statement.startsWith("export")) continue;
    if (/^export\s*\*/.test(statement)) {
      stars.push(imported.specifier);
      continue;
    }
    const binding = namedBindings(statement).find((item) => item.exported === exportedName);
    if (binding) return { direct: false, named: { specifier: imported.specifier, imported: binding.imported }, stars };
  }
  return {
    direct: module.exports.has(exportedName),
    stars,
  };
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
    const target = await reExportTarget(resolved.source, importedName);
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
  const module = await lexModule(source);
  const [localName, namespaceMember] = localExpression.split(".", 2);
  if (!localName) return undefined;
  for (const imported of module.imports) {
    const statement = imported.statement;
    const clause = statement.match(/^import\s+(?:type\s+)?([\s\S]*?)\s+from\b/)?.[1]?.trim();
    if (!clause) continue;
    const namespace = clause.match(/(?:^|,)\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s*$/)?.[1];
    if (namespace === localName && namespaceMember) {
      return { specifier: imported.specifier, imported: namespaceMember };
    }
    for (const binding of namedBindings(clause)) {
      if (binding.exported === localName && namespaceMember === undefined) {
        return { specifier: imported.specifier, imported: binding.imported };
      }
    }
    const defaultBinding = clause.split(",", 1)[0]?.trim();
    if (defaultBinding === localName && namespaceMember === undefined) {
      return { specifier: imported.specifier, imported: "default" };
    }
  }
  return undefined;
}

export function topLevelObjectLiteral(source: string, openBrace: number): string | null {
  let depth = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  return null;
}

export function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
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

export function allocateToolName(preferred: string, method: HttpMethod, used: Set<string>): string {
  const first = limitToolName(preferred);
  if (!used.has(first)) {
    used.add(first);
    return first;
  }
  const methodFallback = limitToolName(`${preferred}_${method.toLowerCase()}`);
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

export function withUniqueNames(tools: ExtractedTool[]): ExtractedTool[] {
  const used = new Set<string>();
  return tools.map((tool) => ({
    ...tool,
    name: allocateToolName(tool.name, tool.binding.method, used),
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
