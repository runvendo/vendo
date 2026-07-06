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

function pathFromSegments(segments: readonly string[]): string {
  const cleaned = segments.map(cleanSegment).filter((segment): segment is string => Boolean(segment));
  return `/${cleaned.join("/")}`.replace(/\/+/g, "/");
}

function appRoutePath(relPath: string): string | null {
  const parts = relPath.replace(/\\/g, "/").split("/");
  const file = parts.at(-1);
  if (!/^route\.tsx?$/.test(file ?? "")) return null;

  const appIndex = parts.findIndex((part) => part === "app");
  if (appIndex === -1) return null;
  const apiIndex = parts.findIndex((part, index) => index > appIndex && part === "api");
  if (apiIndex === -1) return null;

  return pathFromSegments(parts.slice(apiIndex, -1));
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

/** HTTP verbs a route file actually exports or handles — the deterministic ground truth. */
export function exportedVerbs(source: string, kind: RouteSource["kind"] = "app"): Set<HttpMethod> {
  const verbs = new Set<HttpMethod>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    addMethod(verbs, match[1]);
  }
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    addMethod(verbs, match[1]);
  }
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

/**
 * Vendo's own generated catch-all handler (`app/api/vendo/[...path]/route.ts`,
 * or `src/app/api/vendo/...`) must never enter the scan: the LLM would
 * otherwise propose a tool for Vendo's own endpoint, which the export checker
 * then drops with a confusing "exports: none" line (it doesn't recognize the
 * `export const { GET, POST } = createVendoHandler()` destructuring). Anchored
 * on a trailing slash after "vendo" so a legitimate route like `api/vendors`
 * is never caught by this.
 *
 * The `api/vendo` segment is also encoded in state.ts (route path constants)
 * and next-wiring.ts (path.join segments) — a rename must touch all three.
 */
const VENDO_OWN_ROUTE = /(^|\/)app\/api\/vendo\//;

function isVendoOwnRoute(urlPath: string): boolean {
  return urlPath === "/api/vendo" || urlPath.startsWith("/api/vendo/");
}

async function resolveImportSource(importer: string, specifier: string, targetDir: string): Promise<string | null> {
  const base = specifier.startsWith("@/")
    ? path.join(targetDir, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(importer), specifier)
      : null;
  if (!base) return null;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch {
      // Try the next source-owned resolution candidate.
    }
  }
  return null;
}

async function verbsWithReExportFallback(route: RouteSource, targetDir: string): Promise<Set<HttpMethod>> {
  const verbs = exportedVerbs(route.source, route.kind);
  if (verbs.size > 0) return verbs;
  const routeMapVerbs = routeMapMappedVerbs(route.source, route);
  if (routeMapVerbs) return routeMapVerbs;

  const importDefault = route.source.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'][\s\S]*?export\s+default\s+\1\b/);
  const exportDefault = route.source.match(/export\s*\{\s*default\s*\}\s*from\s+["']([^"']+)["']/);
  const delegate = route.source.match(/return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(\s*req\s*,\s*res\b/);
  const specifier = importDefault?.[2] ?? exportDefault?.[1] ?? (delegate?.[1] ? importSpecifierFor(route.source, delegate[1]) : undefined);
  if (!specifier) return inferredPageDefaultVerbs(route.source, route.kind);

  const resolved = await resolveImportSource(route.file, specifier, targetDir);
  if (!resolved) return inferredPageDefaultVerbs(route.source, route.kind);
  const resolvedRouteMapVerbs = routeMapMappedVerbs(resolved, route);
  if (resolvedRouteMapVerbs) return resolvedRouteMapVerbs;
  const resolvedVerbs = exportedVerbs(resolved, route.kind);
  return resolvedVerbs.size > 0 ? resolvedVerbs : inferredPageDefaultVerbs(route.source, route.kind);
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

function inferredPageDefaultVerbs(source: string, kind: RouteSource["kind"]): Set<HttpMethod> {
  const verbs = new Set<HttpMethod>();
  if (kind !== "pages" || !/\bexport\s+default\b/.test(source) || /\breq\.method\b/.test(source)) return verbs;
  if (/\bhandleUpload\s*\(/.test(source) || /\breq\.body\b/.test(source)) verbs.add("POST");
  else verbs.add("GET");
  return verbs;
}

async function routeSources(targetDir: string): Promise<RouteSource[]> {
  const files = await walk(targetDir, (p) => {
    const norm = p.replace(/\\/g, "/");
    return (
      (/\/?app\/.*\/?api\/.*route\.tsx?$/.test(norm) && !VENDO_OWN_ROUTE.test(norm)) ||
      /(^|\/)(?:src\/)?pages\/api\/.*\.(?:tsx?|jsx?)$/.test(norm)
    );
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
