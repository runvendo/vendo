import { describe, expect, it } from "vitest";
import type { ExtractedTool } from "../formats.js";
import { bindingIdentity } from "./common.js";
import { extractorRegistrations, runExtractors, type Extractor } from "./extractors.js";

function routeTool(name: string, path: string): ExtractedTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    risk: "read",
    binding: { kind: "route", method: "GET", path, argsIn: "query" },
  };
}

describe("extractor registrations", () => {
  it("keeps OpenAPI ahead of trpc ahead of graphql ahead of route-scan", () => {
    expect(extractorRegistrations.map((extractor) => extractor.name)).toEqual([
      "openapi",
      "trpc",
      "graphql",
      "route-scan",
    ]);
  });

  it("detects and extracts sequentially in registration order", async () => {
    const calls: string[] = [];
    const registration = (
      name: string,
      detected: boolean,
      tools: ExtractedTool[],
      warnings: string[],
    ): Extractor => ({
      name,
      async detect(root) {
        calls.push(`${name}:detect:${root}`);
        return detected;
      },
      async extract(root) {
        calls.push(`${name}:extract:${root}`);
        return { tools, warnings };
      },
    });

    const result = await runExtractors("/host", [
      registration("openapi", true, [routeTool("host_openapi", "/api/openapi")], ["openapi warning"]),
      registration("skipped", false, [routeTool("host_skipped", "/api/skipped")], ["skipped warning"]),
      registration("route-scan", true, [routeTool("host_route", "/api/route")], ["route warning"]),
    ]);

    expect(calls).toEqual([
      "openapi:detect:/host",
      "openapi:extract:/host",
      "skipped:detect:/host",
      "route-scan:detect:/host",
      "route-scan:extract:/host",
    ]);
    expect(result.tools.map((tool) => tool.name)).toEqual(["host_openapi", "host_route"]);
    expect(result.warnings).toEqual(["openapi warning", "route warning"]);
  });

  it("drops route tools shadowed by a trpc mount, and only those", async () => {
    const trpcTool: ExtractedTool = {
      name: "host_polls_list",
      description: "tRPC query polls.list",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      binding: { kind: "trpc", procedure: "polls.list", type: "query", mount: "/api/trpc" },
    };
    const fake = (name: string, tools: ExtractedTool[]): Extractor => ({
      name,
      detect: async () => true,
      extract: async () => ({ tools, warnings: [] }),
    });
    const result = await runExtractors("/host", [
      fake("trpc", [trpcTool]),
      fake("route-scan", [
        routeTool("host_trpc_catchall", "/api/trpc/{trpc}"),
        routeTool("host_trpc_root", "/api/trpc"),
        routeTool("host_trpcish", "/api/trpcish"),
        routeTool("host_health", "/api/health"),
      ]),
    ]);
    expect(result.tools.map((tool) => tool.name)).toEqual(["host_polls_list", "host_trpcish", "host_health"]);
  });

  it("drops route tools shadowed by a graphql endpoint, and only those", async () => {
    const graphqlTool: ExtractedTool = {
      name: "host_poll_get",
      description: "GraphQL query pollGet",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      binding: { kind: "graphql", operation: "pollGet", type: "query", endpoint: "/api/graphql", document: "query pollGet { pollGet }" },
    };
    const fake = (name: string, tools: ExtractedTool[]): Extractor => ({
      name,
      detect: async () => true,
      extract: async () => ({ tools, warnings: [] }),
    });
    const result = await runExtractors("/host", [
      fake("graphql", [graphqlTool]),
      fake("route-scan", [
        routeTool("host_graphql_catchall", "/api/graphql/{slug}"),
        routeTool("host_graphql_root", "/api/graphql"),
        routeTool("host_graphqlish", "/api/graphqlish"),
        routeTool("host_health", "/api/health"),
      ]),
    ]);
    expect(result.tools.map((tool) => tool.name)).toEqual(["host_poll_get", "host_graphqlish", "host_health"]);
  });

  it("keeps the same operation name distinct across two graphql endpoints", () => {
    const first = bindingIdentity({ kind: "graphql", operation: "pollGet", type: "query", endpoint: "/graphql" });
    const second = bindingIdentity({ kind: "graphql", operation: "pollGet", type: "query", endpoint: "/metadata" });
    expect(first).not.toBe(second);
    expect(bindingIdentity({ kind: "graphql", operation: "pollGet", type: "query", endpoint: "/graphql/" })).toBe(first);
  });

  it("keeps the same procedure name distinct across two trpc mounts", () => {
    // unionExtracted dedups by bindingIdentity — mount must be part of a trpc
    // tool's identity or one of these silently disappears from tools.json.
    const first = bindingIdentity({ kind: "trpc", procedure: "health", type: "query", mount: "/api/trpc" });
    const second = bindingIdentity({ kind: "trpc", procedure: "health", type: "query", mount: "/api/admin/trpc" });
    expect(first).not.toBe(second);
    // Trailing-slash mounts normalize to the same identity.
    expect(bindingIdentity({ kind: "trpc", procedure: "health", type: "query", mount: "/api/trpc/" })).toBe(first);
  });
});
