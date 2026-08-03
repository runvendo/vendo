import { promises as fs } from "node:fs";
import path from "node:path";
import type { SourcedExtractedTool } from "./common.js";
import { detectGraphql, extractGraphql, graphqlEndpoints } from "./graphql.js";
import { extractOpenApi, openApiMountPath } from "./openapi.js";
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
function withoutShadowedRoutes(tools: SourcedExtractedTool[]): SourcedExtractedTool[] {
  const mounts = [...trpcMounts(tools), ...graphqlEndpoints(tools)];
  if (mounts.length === 0) return tools;
  return tools.filter((tool) => {
    if (tool.binding.kind !== "route") return true;
    const { path: routePath } = tool.binding;
    return !mounts.some((mount) => routePath === mount || routePath.startsWith(`${mount}/`));
  });
}

/**
 * THE MOUNT POINT THE WHOLE HOST ANSWERS UNDER, ON EVERY HTTP BINDING.
 *
 * A host is not always at the root of its origin: a Next `basePath`, a reverse
 * proxy, an app mounted inside a bigger one. The runtime does not know that —
 * it joins `binding.path` straight onto the wire origin — so every tool call
 * lands one prefix short of the real endpoint and 404s, while the host's own
 * pages render perfectly because the framework rewrites THOSE for you. The
 * result is a product that looks entirely correct and whose agent quietly has
 * no data.
 *
 * Declared in ONE place — a relative `servers[0].url` in the OpenAPI document —
 * and applied to EVERY http-shaped binding, including the ones route-scan
 * found, because a mount point is a property of the host, not of one extractor.
 * Uniform is also the only consistent choice: `dedupKey` is method+path, so
 * prefixing one extractor's paths and not another's stops an OpenAPI operation
 * and the route handler behind it from collapsing into a single tool and ships
 * both, one of them broken.
 *
 * tRPC and GraphQL bindings address their mount/endpoint separately and are
 * left alone; a subpath-mounted host that also speaks either would need the
 * same treatment there.
 */
function mounted(tools: SourcedExtractedTool[], mount: string): SourcedExtractedTool[] {
  if (mount === "") return tools;
  return tools.map((tool) =>
    tool.binding.kind === "openapi" || tool.binding.kind === "route"
      ? { ...tool, binding: { ...tool.binding, path: `${mount}${tool.binding.path}` } }
      : tool,
  );
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
  const spec = await firstOpenApiSpec(root);
  const mount = spec === null ? "" : await openApiMountPath(spec);
  return { tools: mounted(withoutShadowedRoutes(tools), mount), warnings };
}
