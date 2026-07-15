import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { VendoError } from "@vendoai/core";
import { z } from "zod";
import {
  VENDO_CATALOG_FORMAT,
  VENDO_CATALOG_PROPOSALS_FORMAT,
  catalogFileSchema,
  catalogProposalsFileSchema,
  type CatalogFile,
  type CatalogCopyProposal,
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
      basis: {
        exportPath: entry.exportPath,
        propsSchema: entry.propsSchema,
        ...(entry.note === undefined ? {} : { note: entry.note }),
      },
      before: {
        description: entry.description,
        ...(entry.examples === undefined ? {} : { examples: entry.examples }),
      },
      after: {
        description: proposal.description,
        ...(proposal.examples === undefined ? {} : { examples: proposal.examples }),
      },
    };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
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
  const changes = new Map<string, CatalogCopyProposal>(
    proposals.proposals.filter((proposal) => accepted.has(proposal.name)).map((proposal) => [proposal.name, proposal]),
  );
  if (accepted.size !== changes.size) {
    const missing = [...accepted]
      .filter((name) => !changes.has(name))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    throw new VendoError("validation", `accepted catalog proposals not found: ${missing.join(", ")}`);
  }
  const entries = new Map(catalog.entries.map((entry) => [entry.name, entry]));
  for (const [name, proposal] of changes) {
    const entry = entries.get(name);
    const basis = entry === undefined ? undefined : {
      exportPath: entry.exportPath,
      propsSchema: entry.propsSchema,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    };
    const before = entry === undefined ? undefined : {
      description: entry.description,
      ...(entry.examples === undefined ? {} : { examples: entry.examples }),
    };
    if (entry?.source !== "scanned"
      || !isDeepStrictEqual(basis, proposal.basis)
      || !isDeepStrictEqual(before, proposal.before)) {
      throw new VendoError(
        "validation",
        `stale catalog proposal for ${name}: catalog.json changed since proposal generation; regenerate proposals before accepting`,
      );
    }
  }
  const updated = catalogFileSchema.parse({
    ...catalog,
    entries: catalog.entries.map((entry) => {
      const proposal = changes.get(entry.name);
      return proposal === undefined ? entry : {
        ...entry,
        description: proposal.after.description,
        ...(proposal.after.examples === undefined ? { examples: undefined } : { examples: proposal.after.examples }),
      };
    }),
  });
  await fs.writeFile(catalogPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}
