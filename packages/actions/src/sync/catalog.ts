import { promises as fs } from "node:fs";
import path from "node:path";
import { VendoError } from "@vendoai/core";
import {
  VENDO_CATALOG_FORMAT,
  catalogFileSchema,
  type CatalogEntry,
  type CatalogFile,
} from "../formats.js";
import { writeIfChanged } from "./common.js";

function validationError(file: string, error: unknown): VendoError {
  const detail = error && typeof error === "object" && "issues" in error
    ? { file, issues: (error as { issues: unknown }).issues }
    : { file, error: error instanceof Error ? error.message : String(error) };
  return new VendoError("validation", `malformed catalog file: ${file}`, detail);
}

export async function readCatalogFile(file: string): Promise<CatalogFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return catalogFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw validationError(file, error);
  }
}

/**
 * Replaces the machine-owned inventory. Only accepted copy on still-scanned
 * entries persists; source, schemas, disabled flags, and notes are regenerated.
 */
export function mergeCatalogEntries(existing: CatalogEntry[], scanned: CatalogEntry[]): CatalogEntry[] {
  const previous = new Map(existing.map((entry) => [entry.name, entry]));
  const next: CatalogEntry[] = [];
  for (const entry of scanned) {
    const old = previous.get(entry.name);
    const retainedCopy = entry.source === "scanned" && old?.source === "scanned";
    next.push({
      ...entry,
      description: retainedCopy ? old.description : entry.description,
      ...(retainedCopy && old.examples !== undefined ? { examples: [...old.examples] } : {}),
    });
  }

  return next.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

export async function writeCatalog(out: string, scanned: CatalogEntry[]): Promise<CatalogFile> {
  const file = path.join(out, "catalog.json");
  const existing = await readCatalogFile(file);
  const catalog = catalogFileSchema.parse({
    format: VENDO_CATALOG_FORMAT,
    entries: mergeCatalogEntries(existing?.entries ?? [], scanned),
  });
  await writeIfChanged(file, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}
