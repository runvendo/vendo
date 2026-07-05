import path from "node:path";
import type { LanguageModel } from "ai";
import { writeGenerated } from "../fsx.js";
import { convertOpenApi } from "./openapi.js";
import { scanRoutes } from "./route-scan.js";
import { manifestToolSchema, toolsManifestSchema, type ManifestTool } from "./manifest.js";

export interface ToolsSummary {
  /** Where the tools came from — report-only; the artifact carries no provenance
   *  (the frozen toolsManifestSchema is .strict()). */
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
  let extracted: ManifestTool[] = [];
  let source: ToolsSummary["source"] = "none";

  if (info.openapiPath) {
    extracted = await convertOpenApi(info.openapiPath);
    source = "openapi";
  } else if (model) {
    const scan = await scanRoutes(targetDir, model);
    extracted = scan.tools;
    errors.push(...scan.warnings);
    if (extracted.length > 0) {
      source = "route-scan";
      errors.push(
        "route-scan tools are all marked mutating (fail-closed: this surface is LLM-read) — review tools.json and relax genuinely read-only tools by hand",
      );
    } else errors.push("no OpenAPI spec and no scannable routes found — write .flowlet/tools.json by hand");
  } else {
    errors.push("no OpenAPI spec found and LLM unavailable (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY) — tools.json skipped");
  }

  // Validate per entry against the frozen contract; drop and report invalid
  // entries rather than failing the whole artifact.
  const tools: ManifestTool[] = [];
  for (const t of extracted) {
    const parsed = manifestToolSchema.safeParse(t);
    if (parsed.success) tools.push(parsed.data);
    else errors.push(`dropped tool ${JSON.stringify(t.name)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  if (source !== "none" && tools.length > 0) {
    const valid = toolsManifestSchema.parse({ version: 1, tools, events: [] }); // never emit an invalid artifact
    await writeGenerated(path.join(targetDir, ".flowlet/tools.json"), JSON.stringify(valid, null, 2) + "\n", opts);
  }
  return { source, toolCount: tools.length, errors };
}
