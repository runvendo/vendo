import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtractedTool } from "../formats.js";
import { detectGraphql, extractGraphql, graphqlEndpoints } from "./graphql.js";
import { extractOpenApi } from "./openapi.js";
import { scanRoutes } from "./route-scan.js";
import { detectServerActions, extractServerActions } from "./server-actions.js";
import { detectTrpc, extractTrpc, trpcMounts } from "./trpc.js";

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

const trpcExtractor: Extractor = {
  name: "trpc",
  detect: detectTrpc,
  extract: extractTrpc,
};

const graphqlExtractor: Extractor = {
  name: "graphql",
  detect: detectGraphql,
  extract: extractGraphql,
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
  graphqlExtractor,
  serverActionsExtractor,
  routeScanExtractor,
];

/** Route-scan sees a tRPC mount or a GraphQL endpoint as an opaque catch-all
 * HTTP route; when the trpc/graphql extractors produced real operation tools
 * for that mount, the shadowing route tools are dropped. No trpc/graphql
 * tools → no filtering (unchanged behavior for every other host). */
function withoutShadowedRoutes(tools: ExtractedTool[]): ExtractedTool[] {
  const mounts = [...trpcMounts(tools), ...graphqlEndpoints(tools)];
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
  const tools: ExtractedTool[] = [];
  const warnings: string[] = [];
  for (const extractor of registrations) {
    if (!await extractor.detect(root)) continue;
    const result = await extractor.extract(root);
    tools.push(...result.tools);
    warnings.push(...result.warnings);
  }
  return { tools: withoutShadowedRoutes(tools), warnings };
}
