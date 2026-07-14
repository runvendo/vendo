import { catalogFileSchema } from "@vendoai/actions";
import type { ComponentCatalog, RegisteredComponent } from "@vendoai/core";

function permissivePropsSchema(): RegisteredComponent["propsSchema"] {
  return { "~standard": { validate: (value: unknown) => ({ value }) } };
}

/** Strictly parses catalog@1, returning no registrations when the file is absent or invalid. */
export function runtimeCatalogFromJson(raw: string | undefined): ComponentCatalog {
  if (raw === undefined) return [];
  try {
    const parsed = catalogFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parsed.data.entries
      .filter((entry) => entry.disabled !== true)
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        propsSchema: permissivePropsSchema(),
        propsJsonSchema: entry.propsSchema,
        ...(entry.examples === undefined ? {} : { examples: entry.examples }),
      }));
  } catch {
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
