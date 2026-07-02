import path from "node:path";
import type { LanguageModel } from "ai";
import { writeGenerated } from "../fsx.js";
import { convertOpenApi } from "./openapi.js";
import { scanRoutes } from "./route-scan.js";
import { toolsManifestSchema, type ToolsManifest } from "./manifest.js";

export interface ToolsSummary {
  source: "openapi" | "route-scan" | "none";
  toolCount: number;
  errors: string[];
}

export async function extractTools(
  targetDir: string,
  info: { openapiPath: string | null },
  model: LanguageModel | null,
  opts: { force: boolean },
): Promise<ToolsSummary> {
  const errors: string[] = [];
  let manifest: ToolsManifest | null = null;
  let source: ToolsSummary["source"] = "none";

  if (info.openapiPath) {
    const tools = await convertOpenApi(info.openapiPath);
    manifest = {
      version: 1,
      extractedFrom: { kind: "openapi", path: path.relative(targetDir, info.openapiPath) },
      tools,
      events: [],
    };
    source = "openapi";
  } else if (model) {
    const tools = await scanRoutes(targetDir, model);
    if (tools.length > 0) {
      manifest = { version: 1, extractedFrom: { kind: "route-scan", path: "app/api/**/route.ts" }, tools, events: [] };
      source = "route-scan";
    } else {
      errors.push("no OpenAPI spec and no scannable routes found — write .flowlet/tools.json by hand");
    }
  } else {
    errors.push("no OpenAPI spec found and LLM unavailable (set ANTHROPIC_API_KEY) — tools.json skipped");
  }

  if (manifest) {
    const valid = toolsManifestSchema.parse(manifest); // never emit an invalid artifact
    await writeGenerated(path.join(targetDir, ".flowlet/tools.json"), JSON.stringify(valid, null, 2) + "\n", opts);
  }
  return { source, toolCount: manifest?.tools.length ?? 0, errors };
}
