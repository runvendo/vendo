import { catalogFileSchema, type CatalogFile } from "@vendoai/actions";
import { VendoError, componentPath } from "@vendoai/core";
import type {
  ComponentCatalog,
  ComponentRegistry,
  JsonSchema,
  NormalizedCatalog,
  NormalizedCatalogEntry,
  RegisteredComponent,
  StandardSchema,
  VendoTheme,
} from "@vendoai/core";
import { zodSchema } from "ai";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function permissivePropsSchema(): StandardSchema {
  return { "~standard": { validate: (value: unknown) => ({ value }) } };
}

function ajvIssuePath(error: ErrorObject): Array<string | number> {
  const path = error.instancePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment.replace(/~1/g, "/").replace(/~0/g, "~")));
  const missing = (error.params as { missingProperty?: unknown }).missingProperty;
  if (typeof missing === "string") path.push(missing);
  return path;
}

/** 04 §1 (amended 2026-07-18): a disk entry's JSON Schema is executable, not
 * just prompt guidance — build the entry's runtime validator from it, closing
 * the old pass-through gap. Uncompilable schemas fall back to permissive. */
function diskPropsValidator(schema: JsonSchema, name: string): StandardSchema {
  try {
    const validate = ajv.compile(schema);
    return {
      "~standard": {
        validate: (value: unknown) => {
          if (validate(value)) return { value };
          return {
            issues: (validate.errors ?? []).map((error) => ({
              message: error.message ?? "props did not match the catalog schema",
              path: ajvIssuePath(error),
            })),
          };
        },
      },
    };
  } catch (error) {
    console.warn(
      `[vendo] catalog entry "${name}" has a props schema ajv could not compile (${error instanceof Error ? error.message : String(error)}); validating permissively.`,
    );
    return permissivePropsSchema();
  }
}

function parseIssue(error: unknown): string {
  if (error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    return error.issues.map((issue: unknown) => {
      if (issue === null || typeof issue !== "object") return String(issue);
      const path = "path" in issue && Array.isArray(issue.path) && issue.path.length > 0
        ? `${issue.path.join(".")}: `
        : "";
      return `${path}${"message" in issue ? String(issue.message) : String(issue)}`;
    }).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Core's `/host` component-name grammar, run at BOOT rather than only per turn
 * where the path is built: a name with a hyphen in it ("Data-Table") normalizes
 * fine, boots green, and then throws on every turn for the life of the
 * deployment. Calling core's own builder — never restating its pattern — is what
 * keeps the two ends from disagreeing again.
 *
 * Callers decide what a refusal DOES, and the two answers differ on purpose. A
 * name from `createVendo({ catalog })` throws, pointing at the line to fix. A
 * name from a catalog@1 document was written by `vendo sync` and
 * `catalogEntrySchema` is looser than core's grammar (`$` is legal, no length
 * cap), so throwing lands in `runtimeCatalogFromJson`'s catch and boots the host
 * with ZERO components while advising a sync that regenerates the same file —
 * that entry is dropped with a named warning instead. The residue is real: a host
 * that never mounts `/host` loses its one `Card$Legacy` component, because
 * nothing here can know whether a harness will project the mount.
 */
const projectionRefusal = (name: string, source: string): VendoError | undefined => {
  try {
    componentPath(name);
    return undefined;
  } catch (cause) {
    return new VendoError(
      "validation",
      `${source} declares the component name ${JSON.stringify(name)}, which cannot be projected onto the read-only /host mount: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

/** Task 15a: the parsed-catalog leg of runtimeCatalogFromJson, exported so an
 * in-memory `profile.catalog` (already the catalog@1 file shape) normalizes
 * through the SAME validator-building path as the disk read. */
export function runtimeCatalogFromFile(
  parsed: CatalogFile,
  /** What a bad entry's warning names as its origin — the file by default, because
   *  that is where all but the in-memory `profile.catalog` caller reads from. */
  source = ".vendo/catalog.json",
): NormalizedCatalog {
  const catalog: NormalizedCatalogEntry[] = [];
  for (const entry of parsed.entries) {
    const refusal = projectionRefusal(entry.name, source);
    if (refusal !== undefined) {
      console.warn(`[vendo] ${refusal.message} Skipping that entry; the rest of the catalog loads. Rename the component to recover it.`);
      continue;
    }
    catalog.push({
      name: entry.name,
      description: entry.description,
      propsSchema: diskPropsValidator(entry.propsSchema, entry.name),
      propsJsonSchema: entry.propsSchema,
      ...(entry.examples === undefined ? {} : { examples: entry.examples }),
    });
  }
  return catalog;
}

/**
 * Strictly parses catalog@1. Disk entries carry their JSON Schema for
 * prompting AND validation: the same document drives both (04 §1).
 */
export function runtimeCatalogFromJson(
  raw: string | undefined,
  file = ".vendo/catalog.json",
): NormalizedCatalog {
  if (raw === undefined) return [];
  try {
    return runtimeCatalogFromFile(catalogFileSchema.parse(JSON.parse(raw)), file);
  } catch (error) {
    console.error(
      `[vendo] Failed to load host components from ${file}: ${parseIssue(error)}. Run "vendo sync" to regenerate the file.`,
    );
    return [];
  }
}

function isZodSchema(schema: StandardSchema): boolean {
  const standard = schema["~standard"] as { vendor?: unknown };
  return standard.vendor === "zod";
}

/** Derive the model-facing JSON Schema from a zod entry (01 §14: derived
 * internally, once, at normalization time). Non-zod standard schemas derive
 * nothing — they still validate at runtime and prompt description-only,
 * matching the contract's schema-less semantics. */
function derivedJsonSchema(schema: StandardSchema | undefined, name: string): JsonSchema | undefined {
  if (schema === undefined || !isZodSchema(schema)) return undefined;
  try {
    const { $schema: _meta, ...derived } = zodSchema(
      schema as unknown as Parameters<typeof zodSchema>[0],
    ).jsonSchema as Record<string, unknown>;
    return derived;
  } catch (error) {
    console.warn(
      `[vendo] could not derive a JSON Schema for catalog entry "${name}" (${error instanceof Error ? error.message : String(error)}); the prompt will carry its description only.`,
    );
    return undefined;
  }
}

function normalizeEntry(entry: RegisteredComponent, source: string): NormalizedCatalogEntry {
  const refusal = projectionRefusal(entry.name, source);
  if (refusal !== undefined) throw refusal;
  const derived = derivedJsonSchema(entry.propsSchema, entry.name);
  return {
    name: entry.name,
    description: entry.description,
    ...(entry.propsSchema === undefined ? {} : { propsSchema: entry.propsSchema }),
    ...(derived === undefined ? {} : { propsJsonSchema: derived }),
    ...(entry.examples === undefined ? {} : { examples: entry.examples }),
  };
}

/**
 * 01 §14 (amended 2026-07-18): normalize a `createVendo({ catalog })` value —
 * array form or name-keyed registry form — into the internal catalog. Registry
 * entries: key → `name`, `props` → `propsSchema`, `component` dropped (the
 * server never touches or executes it). Derivation happens here, once.
 */
export function normalizeCatalogConfig(
  config: ComponentCatalog | ComponentRegistry | undefined,
  /** What a bad entry's error names as its origin. The other caller is
   *  `normalizeCatalogConfig(packs.components)`, which cannot reach a bad name:
   *  `mergePacks` ran the same grammar first and its error names the PACK. */
  source = "createVendo({ catalog })",
): NormalizedCatalog {
  if (config === undefined) return [];
  if (Array.isArray(config)) {
    return (config as ComponentCatalog).map((entry) => normalizeEntry(entry, source));
  }
  return Object.entries(config as ComponentRegistry).map(([name, entry]) => normalizeEntry({
    name,
    description: entry.description,
    ...(entry.props === undefined ? {} : { propsSchema: entry.props }),
    ...(entry.examples === undefined ? {} : { examples: entry.examples }),
  }, source));
}

/** AGENT-1 — 03 §3 item (4): the model-facing summary of the host components a
 * generated view may use and how the host's brand should feel. One succinct
 * block; the agent injects it only for venues that render trees. */
export function catalogThemeSummary(
  catalog: NormalizedCatalog,
  theme?: VendoTheme,
): string | undefined {
  const sections: string[] = [];
  if (catalog.length > 0) {
    const lines = catalog.map((entry) =>
      `- ${entry.name}: ${entry.description.split("\n", 1)[0] ?? ""}`.trimEnd());
    sections.push(`Host components (usable in generated views beside the built-in primitives)\n${lines.join("\n")}`);
  }
  if (theme !== undefined) {
    sections.push(
      `Theme: ${theme.density} density, ${theme.motion} motion, ${theme.typography.fontFamily} typography.`,
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/** Explicit createVendo registrations win by name over disk registrations. */
export function mergeRuntimeCatalog(
  disk: NormalizedCatalog,
  explicit: NormalizedCatalog = [],
): NormalizedCatalog {
  const explicitNames = new Set(explicit.map((entry) => entry.name));
  return [
    ...disk.filter((entry) => !explicitNames.has(entry.name)),
    ...explicit,
  ];
}

/**
 * Design §4's `search_components` verb: find what the model may render, by
 * intent.
 *
 * Ranked the same way `find_tools` ranks tools (`searchToolDescriptors` in
 * @vendoai/actions): an exact name token beats a name substring beats a
 * description hit, ties break by name. Deliberately the same shape rather than a
 * cleverer one — a model that has learned how one search behaves should not have
 * to learn a second.
 *
 * It never answers an empty query with the whole catalog. That is not a size
 * guard: a model that can dump the catalog stops searching and starts guessing
 * from the top of the list.
 */
const SEARCH_EXACT_NAME_TOKEN = 8;
const SEARCH_WHOLE_QUERY_IN_NAME = 5;
const SEARCH_NAME_SUBSTRING = 4;
const SEARCH_DESCRIPTION_MATCH = 2;
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;

const searchTokens = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** One catalog entry as the model reads it: today's shipped vocabulary
 *  (`{ component, description, props?, examples? }`, build contract
 *  §5), where `props` is the JSON Schema — a component whose props you cannot see
 *  is a component you cannot use. */
export interface CatalogSearchMatch {
  component: string;
  description: string;
  props?: JsonSchema;
  examples?: string[];
}

export function searchRuntimeCatalog(
  catalog: NormalizedCatalog,
  query: string,
  limit = SEARCH_DEFAULT_LIMIT,
): CatalogSearchMatch[] {
  const wanted = searchTokens(query);
  if (wanted.length === 0) return [];
  const whole = wanted.join("");

  const scored = catalog.map((entry) => {
    const nameTokens = searchTokens(entry.name);
    const flatName = nameTokens.join("");
    const descriptionTokens = new Set(searchTokens(entry.description));
    let score = 0;
    for (const token of wanted) {
      if (nameTokens.includes(token)) score += SEARCH_EXACT_NAME_TOKEN;
      else if (flatName.includes(token)) score += SEARCH_NAME_SUBSTRING;
      if (descriptionTokens.has(token)) score += SEARCH_DESCRIPTION_MATCH;
    }
    if (flatName.includes(whole)) score += SEARCH_WHOLE_QUERY_IN_NAME;
    return { entry, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    .slice(0, Math.min(Math.max(1, Math.trunc(limit)), SEARCH_MAX_LIMIT))
    .map(({ entry }) => ({
      component: entry.name,
      description: entry.description,
      ...(entry.propsJsonSchema === undefined ? {} : { props: entry.propsJsonSchema }),
      ...(entry.examples === undefined ? {} : { examples: [...entry.examples] }),
    }));
}
