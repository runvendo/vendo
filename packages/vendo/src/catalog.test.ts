import type { ComponentCatalog } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { mergeRuntimeCatalog, runtimeCatalogFromJson } from "./catalog.js";

describe("catalog@1 runtime mapping", () => {
  it("maps JSON schemas for prompting, keeps reserved disabled entries, and documents pass-through validation", async () => {
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

    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({
      name: "MetricCard",
      description: "Use for one headline metric.",
      propsJsonSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
      examples: ["<MetricCard value={42} />"],
    });
    expect(await Promise.resolve(catalog[0]!.propsSchema["~standard"].validate({ value: 42 }))).toEqual({ value: { value: 42 } });
    expect(await Promise.resolve(catalog[0]!.propsSchema["~standard"].validate({ value: "not a number", extra: true })))
      .toEqual({ value: { value: "not a number", extra: true } });
    expect(catalog[1]?.name).toBe("HiddenCard");
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
  });

  it("warns loudly and actionably when strict catalog parsing fails", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runtimeCatalogFromJson(
      JSON.stringify({ format: "vendo/catalog@1", entries: [], typo: true }),
      ".vendo/catalog.json",
    )).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain(".vendo/catalog.json");
    expect(error.mock.calls[0]?.[0]).toContain("Unrecognized key");
    expect(error.mock.calls[0]?.[0]).toContain("vendo sync");
  });
});
