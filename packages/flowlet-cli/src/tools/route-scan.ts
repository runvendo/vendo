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

export async function scanRoutes(targetDir: string, model: LanguageModel): Promise<ManifestTool[]> {
  const files = await walk(targetDir, (p) => /(^|\/)app\/api\/.*route\.tsx?$/.test(p.replace(/\\/g, "/")), 200);
  if (files.length === 0) return [];
  const routes = await Promise.all(
    files.map(async (f) => ({ urlPath: urlPathFor(f, targetDir), source: await fs.readFile(f, "utf8") })),
  );
  const raw = await generateJson({ model, schema: routeToolsSchema, prompt: buildPrompt(routes) });
  return raw.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: annotationsFor(t.method, t.name),
    binding: { type: "http" as const, method: t.method.toUpperCase() as HttpMethod, path: t.path },
  }));
}
