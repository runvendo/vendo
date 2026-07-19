import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VENDO_CATALOG_FORMAT,
  catalogFileSchema,
  type CatalogEntry,
} from "../formats.js";
import { mergeCatalogEntries, readCatalogFile, writeCatalog } from "./catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function scanned(name: string, propsSchema: Record<string, unknown> = { type: "object" }): CatalogEntry {
  return { name, exportPath: `./src/${name}.tsx#${name}`, propsSchema, description: "", source: "scanned" };
}

describe("catalog@1", () => {
  it("round-trips strictly and rejects unknown hand-edited fields", () => {
    const catalog = { format: VENDO_CATALOG_FORMAT, entries: [scanned("MetricCard")] };
    expect(catalogFileSchema.parse(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
    expect(() => catalogFileSchema.parse({ ...catalog, typo: true })).toThrow();
    expect(() => catalogFileSchema.parse({ ...catalog, entries: [{ ...catalog.entries[0], typo: true }] })).toThrow();
  });

  it("lets generated registrations win and preserves only accepted scanned copy across rescans", () => {
    const existing: CatalogEntry[] = [
      { ...scanned("Collision", { type: "string" }), source: "registered", description: "Registered copy", disabled: true },
      { ...scanned("MetricCard", { type: "string" }), description: "Use for metrics", examples: ["<MetricCard value={42} />"], disabled: true, note: "Keep this note" },
      scanned("RemovedCard"),
    ];
    const merged = mergeCatalogEntries(existing, [
      { ...scanned("Collision", { type: "number" }), source: "registered", description: "Code registration" },
      { ...scanned("MetricCard", { type: "object", properties: { value: { type: "number" } } }), note: "Scanner note" },
    ]);

    expect(merged.find((entry) => entry.name === "Collision")).toMatchObject({
      source: "registered",
      description: "Code registration",
      propsSchema: { type: "number" },
    });
    expect(merged.find((entry) => entry.name === "MetricCard")).toMatchObject({
      propsSchema: { type: "object", properties: { value: { type: "number" } } },
      description: "Use for metrics",
      examples: ["<MetricCard value={42} />"],
      note: "Scanner note",
    });
    expect(merged.find((entry) => entry.name === "MetricCard")).not.toHaveProperty("disabled");
    expect(merged.some((entry) => entry.name === "RemovedCard")).toBe(false);
  });

  it("writes a catalog file that round-trips through readCatalogFile and is stable on rescans", async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-catalog-write-"));
    temporaryDirectories.push(out);
    const catalog = await writeCatalog(out, [scanned("MetricCard")]);
    expect((await readCatalogFile(path.join(out, "catalog.json")))?.entries[0]).toMatchObject({
      name: "MetricCard",
      exportPath: "./src/MetricCard.tsx#MetricCard",
    });

    const before = await fs.readFile(path.join(out, "catalog.json"), "utf8");
    await writeCatalog(out, [scanned("MetricCard")]);
    expect(await fs.readFile(path.join(out, "catalog.json"), "utf8")).toBe(before);
    expect(catalog.entries).toHaveLength(1);
  });

  it("returns null from readCatalogFile when no catalog has been written", async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-catalog-missing-"));
    temporaryDirectories.push(out);
    expect(await readCatalogFile(path.join(out, "catalog.json"))).toBeNull();
  });
});
