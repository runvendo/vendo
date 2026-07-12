import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { walk } from "../fsx.js";
import { generateJson } from "../llm.js";
import { annotationsFor, type HttpMethod, type ManifestTool } from "./manifest.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

const routeToolSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1),
  method: z.enum(["get", "post", "put", "patch", "delete"]),
  path: z.string().startsWith("/"),
  inputSchema: z.record(z.unknown()).default({}),
});
const routeToolsSchema = z.array(routeToolSchema);

interface RouteSource {
  file: string;
  urlPath: string;
  source: string;
  kind: "app" | "pages";
  catchAll: boolean;
}

interface ResolvedRouteSource {
  file: string;
  source: string;
}

interface TsconfigPathAlias {
  pattern: string;
  targets: string[];
}

interface ReExportTarget {
  specifier: string;
  assumeDefaultExport: boolean;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;
const MAX_REEXPORT_DEPTH = 4;
const tsconfigAliasCache = new Map<string, Promise<TsconfigPathAlias[]>>();

function cleanSegment(segment: string): string | null {
  if (segment.startsWith("(") && segment.endsWith(")")) return null;
  if (segment.startsWith("@")) return null;
  const optionalCatchAll = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
  if (optionalCatchAll?.[1]) return `{${optionalCatchAll[1]}}`;
  const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/);
  if (catchAll?.[1]) return `{${catchAll[1]}}`;
  const dynamic = segment.match(/^\[([^\]]+)\]$/);
  if (dynamic?.[1]) return `{${dynamic[1]}}`;
  return segment;
}

function routeGroupName(segment: string): string | null {
  if (!segment.startsWith("(") || !segment.endsWith(")")) return null;
  return segment.slice(1, -1).toLowerCase();
}

function pathFromSegments(segments: readonly string[]): string {
  const cleaned = segments.map(cleanSegment).filter((segment): segment is string => Boolean(segment));
  return `/${cleaned.join("/")}`.replace(/\/+/g, "/");
}

function isApiAppRoute(routeSegments: readonly string[], urlPath: string): boolean {
  return urlPath === "/api" || urlPath.startsWith("/api/") || routeSegments.some((segment) => routeGroupName(segment) === "api");
}

function appRoutePath(relPath: string): string | null {
  const parts = relPath.replace(/\\/g, "/").split("/");
  const file = parts.at(-1);
  if (!/^route\.tsx?$/.test(file ?? "")) return null;

  const appIndex = parts.findIndex((part) => part === "app");
  if (appIndex === -1) return null;

  const routeSegments = parts.slice(appIndex + 1, -1);
  const urlPath = pathFromSegments(routeSegments);
  if (!isApiAppRoute(routeSegments, urlPath)) return null;
  return urlPath;
}

function pagesRoutePath(relPath: string): string | null {
  const parts = relPath.replace(/\\/g, "/").split("/");
  const pagesIndex = parts.findIndex((part) => part === "pages");
  if (pagesIndex === -1 || parts[pagesIndex + 1] !== "api") return null;

  const file = parts.at(-1);
  if (!file || !/\.(?:tsx?|jsx?)$/.test(file) || /\.d\.ts$/.test(file) || /\.test\./.test(file)) return null;
  const last = file.replace(/\.(?:tsx?|jsx?)$/, "");
  if (last.startsWith("_")) return null;

  const routeSegments = [...parts.slice(pagesIndex + 1, -1), last];
  if (routeSegments.at(-1) === "index") routeSegments.pop();
  return pathFromSegments(routeSegments);
}

function routePathForRel(relPath: string): { kind: RouteSource["kind"]; urlPath: string } | null {
  const appPath = appRoutePath(relPath);
  if (appPath) return { kind: "app", urlPath: appPath };
  const pagesPath = pagesRoutePath(relPath);
  if (pagesPath) return { kind: "pages", urlPath: pagesPath };
  return null;
}

export function deterministicToolName(method: string, urlPath: string): string {
  const parts = [
    method.toLowerCase(),
    ...urlPath
      .split("/")
      .filter(Boolean)
      .filter((segment, index) => !(index === 0 && segment === "api"))
      .flatMap((segment) => {
        const unbraced = segment.startsWith("{") && segment.endsWith("}") ? segment.slice(1, -1) : segment;
        return unbraced.match(/[A-Za-z0-9]+/g) ?? [];
      })
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`),
  ];
  return parts.join("");
}

function pathParamNames(urlPath: string): string[] {
  return [...urlPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!).filter(Boolean);
}

function deterministicInputSchema(urlPath: string): Record<string, unknown> {
  const params = pathParamNames(urlPath);
  const properties = Object.fromEntries(params.map((param) => [param, { type: "string" }]));
  return {
    type: "object",
    properties,
    ...(params.length > 0 ? { required: params } : {}),
  };
}

function buildPrompt(routes: Array<{ urlPath: string; source: string }>): string {
  return [
    "You are extracting an HTTP API surface as agent tool definitions.",
    "For EVERY exported HTTP method handler (GET/POST/PUT/PATCH/DELETE) in the files below,",
    "emit one tool entry. Rules:",
    "- name: deterministic lower-camel method-plus-path (e.g. getTransactionsId).",
    "- description: 1-2 sentences a language model uses to decide when to call the tool;",
    "  describe behaviour, inputs, defaults, notable response fields.",
    "- method/path: the HTTP method (lowercase) and the URL path exactly as given per file.",
    "- inputSchema: JSON Schema object for query/path/body inputs the handler actually reads.",
    "",
    "Respond with ONLY a JSON array of entries:",
    '[{"name":"...","description":"...","method":"get","path":"/...","inputSchema":{...}}]',
    "",
    ...routes.map((r) => `--- path: ${r.urlPath} ---\n${r.source}`),
  ].join("\n");
}

function addMethod(verbs: Set<HttpMethod>, value: string | undefined): void {
  const method = value?.toUpperCase();
  if (method && HTTP_METHOD_SET.has(method)) verbs.add(method as HttpMethod);
}

function addMethodsFromList(verbs: Set<HttpMethod>, source: string): void {
  for (const match of source.matchAll(/["'](GET|POST|PUT|PATCH|DELETE)["']/g)) {
    addMethod(verbs, match[1]);
  }
  for (const part of source.split(",")) {
    addMethod(verbs, part.trim());
  }
}

function statementEnd(source: string, start: number): number {
  let depth = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) return i;
    else if (ch === "\n" && depth === 0 && /^(?:export|import|const|let|var|function|class)\b/.test(source.slice(i + 1).trimStart())) {
      return i;
    }
  }
  return source.length;
}

function splitTopLevelDeclarators(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function addMethodsFromExportedDeclarators(verbs: Set<HttpMethod>, source: string): void {
  const pattern = /export\s+(?:const|let|var)\s+/g;
  for (const match of source.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const declarationList = source.slice(start, statementEnd(source, start));
    for (const declarator of splitTopLevelDeclarators(declarationList)) {
      const name = declarator.trim().match(/^([A-Za-z_$][\w$]*)\b/)?.[1];
      addMethod(verbs, name);
    }
  }
}

/** HTTP verbs a route file actually exports or handles — the deterministic ground truth. */
export function exportedVerbs(source: string, kind: RouteSource["kind"] = "app"): Set<HttpMethod> {
  const verbs = new Set<HttpMethod>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    addMethod(verbs, match[1]);
  }
  addMethodsFromExportedDeclarators(verbs, source);
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
    addMethodsFromList(verbs, match[1] ?? "");
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    const body = match[1] ?? "";
    for (const part of body.split(",")) {
      const trimmed = part.trim();
      const alias = trimmed.match(/\bas\s+(GET|POST|PUT|PATCH|DELETE)\b/);
      addMethod(verbs, alias?.[1] ?? trimmed);
    }
  }

  if (kind === "pages") {
    for (const match of source.matchAll(/\breq\.method\s*(?:={2,3}|!={1,2})\s*["'](GET|POST|PUT|PATCH|DELETE)["']/g)) {
      addMethod(verbs, match[1]);
    }
    for (const match of source.matchAll(/\bcase\s+["'](GET|POST|PUT|PATCH|DELETE)["']/g)) {
      addMethod(verbs, match[1]);
    }
    for (const match of source.matchAll(/setHeader\(\s*["']Allow["']\s*,\s*\[([^\]]+)\]/g)) {
      addMethodsFromList(verbs, match[1] ?? "");
    }
    if (/\bNextAuth\s*\(/.test(source)) {
      verbs.add("GET");
      verbs.add("POST");
    }
  }
  return verbs;
}

export interface RouteScanResult {
  tools: ManifestTool[];
  warnings: string[];
}

/** Vendo's own generated catch-all handler must never enter the host tool scan. */
function isVendoOwnRoute(urlPath: string): boolean {
  return urlPath === "/api/vendo" || urlPath.startsWith("/api/vendo/");
}

function stripJsonComments(source: string): string {
  let stripped = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      stripped += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      stripped += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        stripped += " ";
        i += 1;
      }
      if (i < source.length) stripped += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      stripped += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        stripped += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) stripped += "  ";
      i += 1;
      continue;
    }
    stripped += ch;
  }
  return stripped;
}

function parseJsonLike(source: string): unknown {
  return JSON.parse(stripJsonComments(source).replace(/,\s*([}\]])/g, "$1"));
}

function resolveExtendsPath(value: unknown, configDir: string): string | null {
  if (typeof value !== "string" || (!value.startsWith(".") && !path.isAbsolute(value))) return null;
  const resolved = path.resolve(configDir, value);
  return path.extname(resolved) ? resolved : `${resolved}.json`;
}

async function loadTsconfigAliases(configPath: string, depth = 0): Promise<TsconfigPathAlias[]> {
  let parsed: any;
  try {
    parsed = parseJsonLike(await fs.readFile(configPath, "utf8"));
  } catch {
    return [];
  }

  const configDir = path.dirname(configPath);
  const aliases: TsconfigPathAlias[] = [];
  const extended = depth === 0 ? resolveExtendsPath(parsed?.extends, configDir) : null;
  if (extended) aliases.push(...await loadTsconfigAliases(extended, depth + 1));

  const compilerOptions = parsed?.compilerOptions && typeof parsed.compilerOptions === "object" ? parsed.compilerOptions : {};
  const baseUrl = path.resolve(configDir, typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".");
  const paths = compilerOptions.paths && typeof compilerOptions.paths === "object" ? compilerOptions.paths : {};
  for (const [pattern, rawTargets] of Object.entries(paths)) {
    const targets = Array.isArray(rawTargets)
      ? rawTargets.filter((target): target is string => typeof target === "string").map((target) => path.resolve(baseUrl, target))
      : [];
    if (targets.length > 0) aliases.push({ pattern, targets });
  }
  return aliases;
}

function tsconfigAliases(targetDir: string): Promise<TsconfigPathAlias[]> {
  const key = path.resolve(targetDir);
  const existing = tsconfigAliasCache.get(key);
  if (existing) return existing;
  const aliases = loadTsconfigAliases(path.join(key, "tsconfig.json"));
  tsconfigAliasCache.set(key, aliases);
  return aliases;
}

function importBasesFromAlias(specifier: string, alias: TsconfigPathAlias): string[] {
  const star = alias.pattern.indexOf("*");
  if (star === -1) return specifier === alias.pattern ? alias.targets : [];

  const prefix = alias.pattern.slice(0, star);
  const suffix = alias.pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];

  const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
  return alias.targets.map((target) => target.replace("*", matched));
}

function sourceCandidates(base: string): string[] {
  return [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
}

function isSourceOwnedCandidate(candidate: string): boolean {
  return !candidate.split(path.sep).includes("node_modules");
}

async function resolveImportSource(importer: string, specifier: string, targetDir: string): Promise<ResolvedRouteSource | null> {
  const bases: string[] = [];
  if (specifier.startsWith("@/")) {
    bases.push(path.join(targetDir, specifier.slice(2)));
  } else if (specifier.startsWith(".")) {
    bases.push(path.resolve(path.dirname(importer), specifier));
  } else {
    for (const alias of await tsconfigAliases(targetDir)) {
      bases.push(...importBasesFromAlias(specifier, alias));
    }
  }

  for (const base of bases) {
    for (const candidate of sourceCandidates(base)) {
      if (!isSourceOwnedCandidate(candidate)) continue;
      try {
        return { file: candidate, source: await fs.readFile(candidate, "utf8") };
      } catch {
        // Try the next source-owned resolution candidate.
      }
    }
  }
  return null;
}

function topLevelObjectLiteral(source: string, openBrace: number): string | null {
  let depth = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  return null;
}

function firstObjectArgument(source: string, callee: RegExp): string | null {
  for (const match of source.matchAll(callee)) {
    let index = (match.index ?? 0) + match[0].length;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "(") continue;
    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "{") continue;
    return topLevelObjectLiteral(source, index);
  }
  return null;
}

function methodKeyObjectVerbs(source: string): Set<HttpMethod> | null {
  const objectBody = firstObjectArgument(source, /\bdefaultHandler\s*/g);
  if (!objectBody) return null;

  const verbs = new Set<HttpMethod>();
  for (const entry of splitTopLevelDeclarators(objectBody)) {
    const key = entry.trim().match(/^(?:(["'])(GET|POST|PUT|PATCH|DELETE)\1|(GET|POST|PUT|PATCH|DELETE))\s*:/);
    addMethod(verbs, key?.[2] ?? key?.[3]);
  }
  return verbs.size > 0 ? verbs : null;
}

async function verbsWithReExportFallback(route: RouteSource, targetDir: string): Promise<Set<HttpMethod>> {
  return verbsFromSource(route.file, route.source, route, targetDir, new Set(), 0, false);
}

async function verbsFromSource(
  file: string,
  source: string,
  route: RouteSource,
  targetDir: string,
  visited: Set<string>,
  depth: number,
  assumeDefaultExport: boolean,
): Promise<Set<HttpMethod>> {
  const visitKey = `${file}\t${assumeDefaultExport ? "default" : "named"}`;
  if (visited.has(visitKey)) return new Set();
  visited.add(visitKey);

  const verbs = exportedVerbs(source, route.kind);
  if (verbs.size > 0) return verbs;
  const routeMapVerbs = routeMapMappedVerbs(source, route);
  if (routeMapVerbs) return routeMapVerbs;
  const methodKeyVerbs = methodKeyObjectVerbs(source);
  if (methodKeyVerbs) return methodKeyVerbs;

  if (depth < MAX_REEXPORT_DEPTH) {
    const reExportVerbs = new Set<HttpMethod>();
    for (const target of reExportTargets(source)) {
      const resolved = await resolveImportSource(file, target.specifier, targetDir);
      if (!resolved) continue;
      const nested = await verbsFromSource(
        resolved.file,
        resolved.source,
        route,
        targetDir,
        visited,
        depth + 1,
        target.assumeDefaultExport,
      );
      for (const method of nested) reExportVerbs.add(method);
    }
    if (reExportVerbs.size > 0) return reExportVerbs;
  }

  return inferredPageDefaultVerbs(source, route, assumeDefaultExport);
}

function reExportTargets(source: string): ReExportTarget[] {
  const targets: ReExportTarget[] = [];
  for (const match of source.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) targets.push({ specifier: match[1], assumeDefaultExport: false });
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}\s*from\s+["']([^"']+)["']/g)) {
    const body = match[1] ?? "";
    const specifier = match[2];
    if (!specifier) continue;
    for (const part of body.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const names = trimmed.split(/\s+as\s+/).map((value) => value.trim());
      const exported = names[1] ?? names[0];
      if (exported === "default") targets.push({ specifier, assumeDefaultExport: true });
    }
  }

  const importDefault = source.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'][\s\S]*?export\s+default\s+\1\b/);
  if (importDefault?.[2]) targets.push({ specifier: importDefault[2], assumeDefaultExport: true });

  const delegate = source.match(/return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(\s*req\s*,\s*res\b/);
  const delegateSpecifier = delegate?.[1] ? importSpecifierFor(source, delegate[1]) : undefined;
  if (delegateSpecifier) targets.push({ specifier: delegateSpecifier, assumeDefaultExport: true });

  return targets;
}

function routeMapMappedVerbs(source: string, route: RouteSource): Set<HttpMethod> | null {
  const entries = [...source.matchAll(/["'](GET|POST|PUT|PATCH|DELETE)\s+([^"']+)["']\s*:/g)];
  if (entries.length === 0) return null;

  const verbs = new Set<HttpMethod>();
  const itemRoute = /\/\{[^}]+\}$/.test(route.urlPath);
  for (const entry of entries) {
    const suffix = entry[2] ?? "/";
    const rootEntry = suffix === "/";
    if (route.catchAll || (itemRoute ? !rootEntry : rootEntry)) addMethod(verbs, entry[1]);
  }
  return verbs;
}

function importSpecifierFor(source: string, localName: string): string | undefined {
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g)) {
    if (match[1] === localName) return match[2];
  }
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s+["']([^"']+)["']/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const [imported, alias] = part.split(/\s+as\s+/).map((value) => value.trim());
      if ((alias || imported) === localName) return match[2];
    }
  }
  return undefined;
}

function hasPagesDefaultHandler(source: string, assumeDefaultExport: boolean): boolean {
  return (
    assumeDefaultExport ||
    /\bexport\s+default\b/.test(source) ||
    /export\s*\{[^}]+(?:\bas\s+default\b|\bdefault\b)[^}]*\}\s*from\b/.test(source)
  );
}

function hasDisabledBodyParser(source: string): boolean {
  return /\bbodyParser\s*:\s*false\b/.test(source);
}

function inferredPageDefaultVerbs(source: string, route: RouteSource, assumeDefaultExport = false): Set<HttpMethod> {
  const verbs = new Set<HttpMethod>();
  if (route.kind !== "pages" || !hasPagesDefaultHandler(source, assumeDefaultExport) || /\breq\.method\b/.test(source)) return verbs;

  if (/\bcreateNextApiHandler\s*\(/.test(source)) {
    verbs.add("GET");
    verbs.add("POST");
    return verbs;
  }

  if (/\bhandlerMap\b/.test(source) && /\bapiHandlers\b/.test(source) && route.catchAll) {
    verbs.add("POST");
    return verbs;
  }

  if (/\bhandleUpload\s*\(/.test(source) || /\breq\.body\b/.test(source)) verbs.add("POST");
  // Webhook receivers commonly disable Next's body parser for signature
  // verification and are write-side callbacks even when CE stubs only 404.
  else if (hasDisabledBodyParser(source) || route.urlPath.endsWith("/webhook")) verbs.add("POST");
  else verbs.add("GET");
  return verbs;
}

async function routeSources(targetDir: string): Promise<RouteSource[]> {
  const files = await walk(targetDir, (p) => {
    const norm = p.replace(/\\/g, "/");
    const route = routePathForRel(norm);
    return Boolean(route && !isVendoOwnRoute(route.urlPath));
  }, 5_000);

  const routes: RouteSource[] = [];
  for (const file of files) {
    const rel = path.relative(targetDir, file).replace(/\\/g, "/");
    const route = routePathForRel(rel);
    if (!route || isVendoOwnRoute(route.urlPath)) continue;
    routes.push({ file, ...route, catchAll: /\[\[?\.\.\.[^\]]+\]\]?/.test(rel), source: await fs.readFile(file, "utf8") });
  }
  return routes;
}

function routeSourcePriority(route: RouteSource): number {
  return route.kind === "app" ? 0 : 1;
}

function compareRouteSources(a: RouteSource, b: RouteSource): number {
  return (
    a.urlPath.localeCompare(b.urlPath) ||
    routeSourcePriority(a) - routeSourcePriority(b) ||
    a.file.localeCompare(b.file)
  );
}

/**
 * When both App Router and Pages API files resolve to the same public URL,
 * prefer App Router. Next routes App Router ahead of Pages for the same URL in
 * modern apps, and selecting before verb extraction keeps deterministic tools
 * and LLM validation on the same source file.
 */
function selectPreferredRoutes(routes: readonly RouteSource[]): RouteSource[] {
  const byPath = new Map<string, RouteSource>();
  for (const route of [...routes].sort(compareRouteSources)) {
    if (!byPath.has(route.urlPath)) byPath.set(route.urlPath, route);
  }
  return [...byPath.values()].sort(compareRouteSources);
}

function buildDeterministicTool(route: RouteSource, method: HttpMethod): ManifestTool {
  const name = deterministicToolName(method, route.urlPath);
  return {
    name,
    description: `${method} ${route.urlPath}`,
    inputSchema: deterministicInputSchema(route.urlPath),
    annotations: annotationsFor(method, name, "route-scan"),
    binding: { type: "http" as const, method, path: route.urlPath },
  };
}

export async function scanRoutes(targetDir: string, model: LanguageModel | null = null): Promise<RouteScanResult> {
  const routes = selectPreferredRoutes(await routeSources(targetDir));
  if (routes.length === 0) return { tools: [], warnings: [] };

  const warnings: string[] = [];
  const toolsByKey = new Map<string, ManifestTool>();
  const verbsByPath = new Map<string, Set<HttpMethod>>();

  for (const route of routes) {
    const verbs = await verbsWithReExportFallback(route, targetDir);
    verbsByPath.set(route.urlPath, verbs);
    for (const method of verbs) {
      const key = `${method}\t${route.urlPath}`;
      if (!toolsByKey.has(key)) toolsByKey.set(key, buildDeterministicTool(route, method));
    }
    if (verbs.size === 0) {
      warnings.push(`route ${route.urlPath} has no supported HTTP method checks or exports`);
    }
  }

  const tools = [...toolsByKey.values()];
  if (!model) return { tools, warnings };

  if (routes.length > 80) {
    warnings.push(`skipped LLM route enrichment for ${routes.length} route files; deterministic route inventory was used`);
    return { tools, warnings };
  }

  let raw: z.infer<typeof routeToolsSchema>;
  try {
    raw = await generateJson({ model, schema: routeToolsSchema, prompt: buildPrompt(routes) });
  } catch (error) {
    warnings.push(`LLM route enrichment failed (${error instanceof Error ? error.message : String(error)}) — deterministic route inventory was used`);
    return { tools, warnings };
  }
  for (const t of raw) {
    const method = t.method.toUpperCase() as HttpMethod;
    const actual = verbsByPath.get(t.path);
    if (!actual) {
      warnings.push(`dropped tool ${JSON.stringify(t.name)}: no route file matches path ${t.path}`);
      continue;
    }
    if (!actual.has(method)) {
      warnings.push(
        `dropped tool ${JSON.stringify(t.name)}: handler for ${t.path} does not export ${method} (exports: ${[...actual].join(", ") || "none"})`,
      );
      continue;
    }
    const tool = toolsByKey.get(`${method}\t${t.path}`);
    if (tool) {
      tool.description = t.description;
      tool.inputSchema = t.inputSchema;
    }
  }
  return { tools, warnings };
}
