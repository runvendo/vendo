import { catalogFileSchema } from "@vendoai/actions";
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
 * Strictly parses catalog@1. Disk entries carry their JSON Schema for
 * prompting AND validation: the same document drives both (04 §1).
 */
export function runtimeCatalogFromJson(
  raw: string | undefined,
  file = ".vendo/catalog.json",
): NormalizedCatalog {
  if (raw === undefined) return [];
  try {
    const parsed = catalogFileSchema.parse(JSON.parse(raw));
    return parsed.entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      propsSchema: diskPropsValidator(entry.propsSchema, entry.name),
      propsJsonSchema: entry.propsSchema,
      ...(entry.examples === undefined ? {} : { examples: entry.examples }),
    }));
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

function normalizeEntry(entry: RegisteredComponent): NormalizedCatalogEntry {
  const derived = derivedJsonSchema(entry.propsSchema, entry.name);
  return {
    name: entry.name,
    description: entry.description,
    ...(entry.propsSchema === undefined ? {} : { propsSchema: entry.propsSchema }),
    ...(derived === undefined ? {} : { propsJsonSchema: derived }),
    ...(entry.examples === undefined ? {} : { examples: entry.examples }),
    ...(entry.remixable === undefined ? {} : { remixable: entry.remixable }),
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
): NormalizedCatalog {
  if (config === undefined) return [];
  if (Array.isArray(config)) return (config as ComponentCatalog).map(normalizeEntry);
  return Object.entries(config as ComponentRegistry).map(([name, entry]) => normalizeEntry({
    name,
    description: entry.description,
    ...(entry.props === undefined ? {} : { propsSchema: entry.props }),
    ...(entry.examples === undefined ? {} : { examples: entry.examples }),
    ...(entry.remixable === undefined ? {} : { remixable: entry.remixable }),
  }));
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
