import { catalogFileSchema } from "@vendoai/actions";
import type { ComponentCatalog, RegisteredComponent } from "@vendoai/core";

function permissivePropsSchema(): RegisteredComponent["propsSchema"] {
  return { "~standard": { validate: (value: unknown) => ({ value }) } };
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
 * Strictly parses catalog@1. Disk entries retain JSON Schema prompt guidance,
 * while their StandardSchema validator intentionally passes props through.
 */
export function runtimeCatalogFromJson(
  raw: string | undefined,
  file = ".vendo/catalog.json",
): ComponentCatalog {
  if (raw === undefined) return [];
  try {
    const parsed = catalogFileSchema.parse(JSON.parse(raw));
    return parsed.entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      propsSchema: permissivePropsSchema(),
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

/** Explicit createVendo registrations win by name over disk registrations. */
export function mergeRuntimeCatalog(
  disk: ComponentCatalog,
  explicit: ComponentCatalog = [],
): ComponentCatalog {
  const explicitNames = new Set(explicit.map((entry) => entry.name));
  return [
    ...disk.filter((entry) => !explicitNames.has(entry.name)),
    ...explicit,
  ];
}
