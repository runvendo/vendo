import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VENDO_CATALOG_FORMAT, catalogFileSchema } from "../formats.js";
import { scanComponentCatalog } from "./catalog-scan.js";
import { mergeCatalogEntries } from "./catalog.js";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../../");

describe("committed demo catalog drift guard", () => {
  it.each([
    { app: "demo-bank", names: ["MapleNetWorthCard", "MapleSparkline", "MapleSpendingDonut"] },
    { app: "demo-accounting", names: ["CadenceDocProgress", "CadenceMissingDocsHero", "CadenceStatusBadge"] },
  ])("keeps $app catalog.json aligned with compiler extraction", async ({ app, names }) => {
    const root = path.join(repoRoot, "apps", app);
    const committed = catalogFileSchema.parse(JSON.parse(
      await fs.readFile(path.join(root, ".vendo", "catalog.json"), "utf8"),
    ));
    const scanned = await scanComponentCatalog(root);

    expect(scanned.entries.map((entry) => entry.name)).toEqual(names);
    expect(scanned).toMatchObject({ discovered: names.length, registered: names.length });
    expect({
      format: VENDO_CATALOG_FORMAT,
      entries: mergeCatalogEntries(committed.entries, scanned.entries),
    }).toEqual(committed);
  });
});
