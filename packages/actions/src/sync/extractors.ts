import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtractedTool } from "../formats.js";
import { extractOpenApi } from "./openapi.js";
import { scanRoutes } from "./route-scan.js";

export interface ExtractorResult {
  tools: ExtractedTool[];
  warnings: string[];
}

export interface Extractor {
  readonly name: string;
  detect(root: string): Promise<boolean>;
  extract(root: string): Promise<ExtractorResult>;
}

async function firstOpenApiSpec(root: string): Promise<string | null> {
  const candidates = [
    "openapi.json",
    "openapi.yaml",
    "openapi.yml",
    path.join("public", "openapi.json"),
    path.join("docs", "openapi.json"),
    path.join("docs", "openapi.yaml"),
  ];
  for (const relative of candidates) {
    const candidate = path.join(root, relative);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // First existing file wins; absent candidates are expected.
    }
  }
  return null;
}

const openApiExtractor: Extractor = {
  name: "openapi",
  async detect(root) {
    return (await firstOpenApiSpec(root)) !== null;
  },
  async extract(root) {
    const specPath = await firstOpenApiSpec(root);
    return { tools: specPath ? await extractOpenApi(specPath) : [], warnings: [] };
  },
};

const routeScanExtractor: Extractor = {
  name: "route-scan",
  async detect() {
    return true;
  },
  extract: scanRoutes,
};

export const extractorRegistrations: readonly Extractor[] = [
  openApiExtractor,
  routeScanExtractor,
];

export async function runExtractors(
  root: string,
  registrations: readonly Extractor[] = extractorRegistrations,
): Promise<ExtractorResult> {
  const tools: ExtractedTool[] = [];
  const warnings: string[] = [];
  for (const extractor of registrations) {
    if (!await extractor.detect(root)) continue;
    const result = await extractor.extract(root);
    tools.push(...result.tools);
    warnings.push(...result.warnings);
  }
  return { tools, warnings };
}
