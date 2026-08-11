import { promises as fs } from "node:fs";
import path from "node:path";
import type { SourcedExtractedTool } from "./common.js";
import { extractOpenApi } from "./openapi.js";
import { scanRoutes } from "./route-scan.js";
import { detectServerActions, extractServerActions } from "./server-actions.js";
import { detectTrpc, extractTrpc, trpcMounts } from "./trpc.js";

export interface ExtractorResult {
  tools: SourcedExtractedTool[];
  warnings: string[];
}

export interface Extractor {
  readonly name: string;
  detect(root: string): Promise<boolean>;
  extract(root: string): Promise<ExtractorResult>;
}

/** The first OpenAPI document the extractors find, in their order. */
export async function firstOpenApiSpec(root: string): Promise<string | null> {
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
    if (!specPath) return { tools: [], warnings: [] };
    // The spec is every OpenAPI tool's known source file (v3 srcHash input).
    const srcPath = path.relative(root, specPath).split(path.sep).join("/");
    return { tools: (await extractOpenApi(specPath)).map((tool) => ({ ...tool, srcPath })), warnings: [] };
  },
};

const trpcExtractor: Extractor = {
  name: "trpc",
  detect: detectTrpc,
  extract: extractTrpc,
};

const serverActionsExtractor: Extractor = {
  name: "server-actions",
  detect: detectServerActions,
  extract: extractServerActions,
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
  trpcExtractor,
  serverActionsExtractor,
  routeScanExtractor,
];

/** Route-scan sees a tRPC mount as an opaque catch-all HTTP route; when the
 * trpc extractor produced real procedure tools for that mount, the shadowing
 * route tools are dropped. No trpc tools → no filtering (unchanged behavior
 * for every other host). */
function withoutShadowedRoutes(tools: SourcedExtractedTool[]): SourcedExtractedTool[] {
  const mounts = trpcMounts(tools);
  if (mounts.length === 0) return tools;
  return tools.filter((tool) => {
    if (tool.binding.kind !== "route") return true;
    const { path: routePath } = tool.binding;
    return !mounts.some((mount) => routePath === mount || routePath.startsWith(`${mount}/`));
  });
}

export async function runExtractors(
  root: string,
  registrations: readonly Extractor[] = extractorRegistrations,
): Promise<ExtractorResult> {
  const tools: SourcedExtractedTool[] = [];
  const warnings: string[] = [];
  for (const extractor of registrations) {
    if (!await extractor.detect(root)) continue;
    const result = await extractor.extract(root);
    tools.push(...result.tools);
    warnings.push(...result.warnings);
  }
  // Stored paths are PREFIX-FREE (spec 2026-08-06 §B1). The deployment's path
  // prefix lives in VENDO_BASE_URL and is attached exactly once, at call time,
  // by core's joinUrl — baking it in here is what produced /maple/maple/… (#914).
  return { tools: withoutShadowedRoutes(tools), warnings };
}
