import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { walk } from "../fsx.js";
import { generateJson } from "../llm.js";
import { annotationsFor, type HttpMethod, type ManifestTool } from "./manifest.js";

const routeToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  method: z.enum(["get", "post", "put", "patch", "delete"]),
  path: z.string().startsWith("/"),
  inputSchema: z.record(z.unknown()),
});
const routeToolsSchema = z.array(routeToolSchema);

function urlPathFor(routeFile: string, targetDir: string): string {
  // src/app/api/transactions/[id]/route.ts -> /api/transactions/{id}
  const rel = path.relative(targetDir, routeFile).replace(/\\/g, "/");
  const inApp = rel.replace(/^(src\/)?app/, "").replace(/\/route\.tsx?$/, "");
  return inApp.replace(/\[([^\]]+)\]/g, "{$1}") || "/";
}

function buildPrompt(routes: Array<{ urlPath: string; source: string }>): string {
  return [
    "You are extracting an HTTP API surface as agent tool definitions.",
    "For EVERY exported HTTP method handler (GET/POST/PUT/PATCH/DELETE) in the files below,",
    "emit one tool entry. Rules:",
    '- name: snake_case verb_noun (e.g. "list_transactions", "create_payment").',
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

/** HTTP verbs a route file actually exports — the deterministic ground truth. */
export function exportedVerbs(source: string): Set<string> {
  const verbs = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    verbs.add(m[1]!);
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

export async function scanRoutes(targetDir: string, model: LanguageModel): Promise<RouteScanResult> {
  const files = await walk(targetDir, (p) => {
    const norm = p.replace(/\\/g, "/");
    return /(^|\/)app\/api\/.*route\.tsx?$/.test(norm) && !VENDO_OWN_ROUTE.test(norm);
  }, 200);
  if (files.length === 0) return { tools: [], warnings: [] };
  const routes = await Promise.all(
    files.map(async (f) => ({ urlPath: urlPathFor(f, targetDir), source: await fs.readFile(f, "utf8") })),
  );
  // The LLM-reported method drives annotations downstream, so it is never
  // trusted: every (path, method) must match a verb the handler actually exports.
  const verbsByPath = new Map(routes.map((r) => [r.urlPath, exportedVerbs(r.source)]));

  const raw = await generateJson({ model, schema: routeToolsSchema, prompt: buildPrompt(routes) });
  const tools: ManifestTool[] = [];
  const warnings: string[] = [];
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
    tools.push({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: annotationsFor(method, t.name, "route-scan"),
      binding: { type: "http" as const, method, path: t.path },
    });
  }
  return { tools, warnings };
}
