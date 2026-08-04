/**
 * The `/host/components` projection: what a model with hands reads instead of
 * searching. One file per catalog entry, the whole description and the whole
 * props schema — a component whose props you cannot see is one you cannot use.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedCatalogEntry } from "./catalog.js";
import { HOST_COMPONENTS_MOUNT, componentPath, hostComponentFiles } from "./host-components.js";

const entry = (over: Partial<NormalizedCatalogEntry> = {}): NormalizedCatalogEntry => ({
  name: "Stat",
  description: "One headline number with a label under it.",
  propsJsonSchema: {
    type: "object",
    properties: { label: { type: "string" }, value: { type: "number" } },
    required: ["label", "value"],
  },
  ...over,
});

describe("component reference paths (build contract §3.1)", () => {
  it("puts every entry at /host/components/<Name>.md", () => {
    expect(HOST_COMPONENTS_MOUNT).toBe("/host/components");
    expect(componentPath("DataTable")).toBe("/host/components/DataTable.md");
  });

  for (const name of ["../../etc/passwd", "a/b", "with space", "", ".", "Data-Table", "9Lives", "Stat.md"]) {
    it(`refuses to build a path for ${JSON.stringify(name)}`, () => {
      expect(() => componentPath(name)).toThrow(/component name/i);
    });
  }
});

describe("hostComponentFiles — one file per entry", () => {
  it("projects exactly one file per catalog entry", () => {
    const files = hostComponentFiles([entry(), entry({ name: "BarChart", description: "Bars." })]);

    expect(Object.keys(files).sort()).toEqual([
      "/host/components/BarChart.md",
      "/host/components/Stat.md",
    ]);
  });

  it("carries the name, the whole description, and the props schema readably", () => {
    const file = hostComponentFiles([entry()])["/host/components/Stat.md"] ?? "";

    expect(file.startsWith("# Stat\n")).toBe(true);
    expect(file).toContain("One headline number with a label under it.");
    // Pretty-printed inside a fenced block, so the model reads the shape rather
    // than parsing one long line.
    expect(file).toContain("```json");
    expect(file).toContain('"label"');
    expect(file).toContain('"required"');
    expect(file).toContain("\n    \"value\": {");
  });

  it("keeps a multi-line description whole — the listing's one line is not the reference", () => {
    const description = "A table of rows.\n\nSorts by any column, and paginates past fifty rows.";
    const file = hostComponentFiles([entry({ name: "DataTable", description })])["/host/components/DataTable.md"] ?? "";

    expect(file).toContain(description);
  });

  it("says so plainly when an entry declares no props schema", () => {
    const file = hostComponentFiles([entry({ name: "Callout", propsJsonSchema: undefined })])["/host/components/Callout.md"] ?? "";

    expect(file).toContain("no props schema");
    expect(file).not.toContain("```json");
  });

  it("includes the entry's own examples when it has them", () => {
    const file = hostComponentFiles([entry({ examples: ['<Stat label="Total" value={sum(invoices.cents)}/>'] })])["/host/components/Stat.md"] ?? "";

    expect(file).toContain("## Examples");
    expect(file).toContain('<Stat label="Total" value={sum(invoices.cents)}/>');
  });

  it("writes no Examples heading for an entry with none", () => {
    expect(hostComponentFiles([entry()])["/host/components/Stat.md"]).not.toContain("## Examples");
  });

  it("projects nothing for an empty catalog", () => {
    expect(hostComponentFiles([])).toEqual({});
  });
});
