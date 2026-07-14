import { promises as fs } from "node:fs";
import path from "node:path";
import { VendoError } from "@vendoai/core";
import { z } from "zod";
import {
  VENDO_CATALOG_FORMAT,
  VENDO_CATALOG_PROPOSALS_FORMAT,
  catalogFileSchema,
  catalogProposalsFileSchema,
  type CatalogFile,
  type CatalogProposalsFile,
} from "../formats.js";
import { readCatalogFile } from "./catalog.js";

const generatedCopySchema = z.object({
  proposals: z.array(z.object({
    name: z.string(),
    description: z.string().min(1),
    examples: z.array(z.string().min(1)).optional(),
  }).strict()),
}).strict();

export interface CatalogCopyRequest {
  instruction: string;
  entries: Array<{
    name: string;
    exportPath: string;
    propsSchema: Record<string, unknown>;
    note?: string;
  }>;
}

export type CatalogCopyGenerator = (request: CatalogCopyRequest) => Promise<unknown>;

/**
 * Invokes an injected LLM seam and writes only a before/after proposal file.
 * The deterministic catalog is deliberately not writable from this path.
 */
export async function proposeCatalogCopy(
  out: string,
  catalog: CatalogFile,
  generate: CatalogCopyGenerator,
): Promise<CatalogProposalsFile> {
  const scanned = catalog.entries.filter((entry) => entry.source === "scanned" && entry.disabled !== true);
  const raw = await generate({
    instruction: "For each component, propose concise when-to-use guidance and optional valid JSX examples. Return copy fields only; do not restate or change names, export paths, or prop schemas.",
    entries: scanned.map(({ name, exportPath, propsSchema, note }) => ({
      name,
      exportPath,
      propsSchema,
      ...(note === undefined ? {} : { note }),
    })),
  });
  const generated = generatedCopySchema.parse(raw);
  const byName = new Map(scanned.map((entry) => [entry.name, entry]));
  const seen = new Set<string>();
  const proposals = generated.proposals.map((proposal) => {
    const entry = byName.get(proposal.name);
    if (entry === undefined) throw new VendoError("validation", `catalog copy proposal targets unknown scanned component: ${proposal.name}`);
    if (seen.has(proposal.name)) throw new VendoError("validation", `catalog copy proposal repeats component: ${proposal.name}`);
    seen.add(proposal.name);
    return {
      name: proposal.name,
      before: {
        description: entry.description,
        ...(entry.examples === undefined ? {} : { examples: entry.examples }),
      },
      after: {
        description: proposal.description,
        ...(proposal.examples === undefined ? {} : { examples: proposal.examples }),
      },
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const artifact = catalogProposalsFileSchema.parse({
    format: VENDO_CATALOG_PROPOSALS_FORMAT,
    catalogFormat: VENDO_CATALOG_FORMAT,
    proposals,
  });
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "catalog.proposals.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

/** Explicit review/acceptance is the sole path from proposals into catalog.json. */
export async function acceptCatalogProposals(out: string, acceptedNames: readonly string[]): Promise<CatalogFile> {
  const catalogPath = path.join(out, "catalog.json");
  const proposalsPath = path.join(out, "catalog.proposals.json");
  const catalog = await readCatalogFile(catalogPath);
  if (catalog === null) throw new VendoError("not-found", `catalog file not found: ${catalogPath}`);
  let proposals: CatalogProposalsFile;
  try {
    proposals = catalogProposalsFileSchema.parse(JSON.parse(await fs.readFile(proposalsPath, "utf8")));
  } catch (error) {
    throw new VendoError("validation", `malformed catalog proposals file: ${proposalsPath}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const accepted = new Set(acceptedNames);
  const changes = new Map(proposals.proposals.filter((proposal) => accepted.has(proposal.name)).map((proposal) => [proposal.name, proposal.after]));
  if (accepted.size !== changes.size) {
    const missing = [...accepted].filter((name) => !changes.has(name)).sort();
    throw new VendoError("validation", `accepted catalog proposals not found: ${missing.join(", ")}`);
  }
  const updated = catalogFileSchema.parse({
    ...catalog,
    entries: catalog.entries.map((entry) => {
      const change = changes.get(entry.name);
      return change === undefined ? entry : {
        ...entry,
        description: change.description,
        ...(change.examples === undefined ? { examples: undefined } : { examples: change.examples }),
      };
    }),
  });
  await fs.writeFile(catalogPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}
