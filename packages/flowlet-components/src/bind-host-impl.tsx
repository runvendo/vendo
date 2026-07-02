import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";
import { createPrewiredImpl } from "./impl-helpers/create-impl";
import type { HostComponentDescriptor } from "./host-component";

/**
 * Bind a host descriptor to its React adapter — the React half of the
 * registration path.
 *
 * The adapter receives schema-validated JSON props and typically just maps
 * them onto the host app's REAL component (translating host-only inputs:
 * host CSS vars → --flowlet-* tokens, callbacks → flowlet.dispatch, etc.).
 * The returned component carries the same protections as the built-in
 * catalog: props are validated against the descriptor's schema (schema-invalid
 * props render an inline fallback, never garbage into the host component) and
 * an error boundary contains render-time throws to the node.
 */
export function bindHostImpl<S extends z.ZodType>(
  descriptor: HostComponentDescriptor & { propsSchema: S },
  adapt: (props: z.infer<S>) => ReactNode,
): ComponentType<Record<string, unknown>> {
  return createPrewiredImpl(descriptor.propsSchema, adapt);
}
