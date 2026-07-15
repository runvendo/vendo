import { describe, expect, it } from "vitest";
import type { ExtractedTool } from "../formats.js";
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
  it("keeps OpenAPI ahead of route-scan", () => {
    expect(extractorRegistrations.slice(0, 2).map((extractor) => extractor.name)).toEqual([
      "openapi",
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
});
