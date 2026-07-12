import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@vendoai/core";
import type { ExtractedTool, HttpMethod } from "../formats.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist"]);

interface TsconfigPathAlias {
  pattern: string;
  targets: string[];
}

export interface ResolvedSource {
  file: string;
  source: string;
}

const aliasCache = new Map<string, Promise<TsconfigPathAlias[]>>();

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
        if (!SKIP_DIRS.has(entry.name)) await visit(full);
      } else if (keep(path.relative(root, full))) {
        files.push(full);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function stripJsonComments(source: string): string {
  let output = "";
  let quote: "'" | "\"" | null = null;
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
    if (character === "'" || character === "\"") {
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
  return JSON.parse(stripJsonComments(source).replace(/,\s*([}\]])/g, "$1"));
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

export async function resolveImportSource(importer: string, specifier: string, root: string): Promise<ResolvedSource | null> {
  const bases: string[] = [];
  if (specifier.startsWith("@/")) bases.push(path.join(root, specifier.slice(2)));
  else if (specifier.startsWith(".")) bases.push(path.resolve(path.dirname(importer), specifier));
  else {
    for (const alias of await aliasesFor(root)) bases.push(...aliasBases(specifier, alias));
  }
  for (const base of bases) {
    for (const candidate of candidates(base)) {
      if (candidate.split(path.sep).includes("node_modules")) continue;
      try {
        return { file: candidate, source: await fs.readFile(candidate, "utf8") };
      } catch {
        // Try the next source-owned candidate.
      }
    }
  }
  return null;
}

export function importSpecifierFor(source: string, localName: string): string | undefined {
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g)) {
    if (match[1] === localName) return match[2];
  }
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s+["']([^"']+)["']/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const [imported, alias] = part.trim().split(/\s+as\s+/).map((value) => value.trim());
      if ((alias || imported) === localName) return match[2];
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
