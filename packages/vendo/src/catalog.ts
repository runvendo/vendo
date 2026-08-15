import { catalogFileSchema, type CatalogFile } from "@vendoai/actions";
import {
  type JsonSchema,
  log,
  VendoError,
} from "@vendoai/core";
import {
  componentPath,
} from "@vendoai/apps/contract";
import type {
  ComponentCatalog,
  ComponentRegistry,
  NormalizedCatalog,
  NormalizedCatalogEntry,
  RegisteredComponent,
  StandardSchema,
} from "@vendoai/apps/contract";
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
    log({
      code: "vendo.catalog-props-schema-uncompilable",
      level: "warn",
      message:
        `[vendo] catalog entry "${name}" has a props schema ajv could not compile (${error instanceof Error ? error.message : String(error)}); validating permissively.`,
    });
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
      log({
        code: "vendo.catalog-entry-refused",
        level: "warn",
        message: `[vendo] ${refusal.message} Skipping that entry; the rest of the catalog loads. Rename the component to recover it.`,
      });
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
    log({
      code: "vendo.catalog-load-failed",
      level: "error",
      message:
        `[vendo] Failed to load host components from ${file}: ${parseIssue(error)}. Run "vendo sync" to regenerate the file.`,
    });
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
    log({
      code: "vendo.catalog-json-schema-derivation-failed",
      level: "warn",
      message:
        `[vendo] could not derive a JSON Schema for catalog entry "${name}" (${error instanceof Error ? error.message : String(error)}); the prompt will carry its description only.`,
    });
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
  /** What a bad entry's error names as its origin. */
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
