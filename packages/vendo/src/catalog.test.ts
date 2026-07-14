import type { ComponentCatalog } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { mergeRuntimeCatalog, runtimeCatalogFromJson } from "./catalog.js";

describe("catalog@1 runtime mapping", () => {
  it("maps JSON props schemas onto RegisteredComponent and excludes disabled entries", async () => {
    const catalog = runtimeCatalogFromJson(JSON.stringify({
      format: "vendo/catalog@1",
      entries: [
        {
          name: "MetricCard",
          exportPath: "./src/metric.tsx#MetricCard",
          propsSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
          description: "Use for one headline metric.",
          examples: ["<MetricCard value={42} />"],
          source: "scanned",
        },
        {
          name: "HiddenCard",
          exportPath: "./src/hidden.tsx#HiddenCard",
          propsSchema: {},
          description: "Hidden",
          source: "scanned",
          disabled: true,
        },
      ],
    }));

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      name: "MetricCard",
      description: "Use for one headline metric.",
      propsJsonSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
      examples: ["<MetricCard value={42} />"],
    });
    expect(await Promise.resolve(catalog[0]!.propsSchema["~standard"].validate({ value: 42 }))).toEqual({ value: { value: 42 } });
  });

  it("lets explicit registrations win and rejects unknown catalog fields", () => {
    const disk = runtimeCatalogFromJson(JSON.stringify({
      format: "vendo/catalog@1",
      entries: [{ name: "MetricCard", exportPath: "./metric#MetricCard", propsSchema: {}, description: "disk", source: "scanned" }],
    }));
    const explicit: ComponentCatalog = [{
      name: "MetricCard",
      description: "explicit",
      propsSchema: { "~standard": { validate: (value: unknown) => ({ value }) } },
    }];
    expect(mergeRuntimeCatalog(disk, explicit)).toEqual(explicit);
    expect(runtimeCatalogFromJson(JSON.stringify({ format: "vendo/catalog@1", entries: [], typo: true }))).toEqual([]);
  });
});
