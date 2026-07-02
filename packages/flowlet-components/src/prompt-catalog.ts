import type { RegisteredComponent } from "@flowlet/core";

/** Compact "{ field, optional? }" hint from a component's zod props schema, so
 *  the model uses exact prop names (e.g. Callout's `text`, not `body`).
 *  Duck-typed on ZodObject's `.shape` — non-object schemas yield no hint. */
function fieldHint(schema: unknown): string {
  const shape = (schema as { shape?: Record<string, { isOptional?: () => boolean }> }).shape;
  if (!shape) return "";
  const parts = Object.entries(shape).map(([key, def]) =>
    typeof def?.isOptional === "function" && def.isOptional() ? `${key}?` : key,
  );
  return parts.length ? `  props: { ${parts.join(", ")} }` : "";
}

/**
 * Render registry entries as the system-prompt catalog lines the agent reads:
 * one `- Name: description  props: { … }` line per component. Use it for both
 * the prewired catalog and a HOST COMPONENTS section (docs/host-components.md)
 * instead of hand-rolling the formatting per app.
 */
export function componentPromptCatalog(components: RegisteredComponent[]): string {
  return components
    .map((c) => `- ${c.name}: ${c.description}${fieldHint(c.propsSchema)}`)
    .join("\n");
}
