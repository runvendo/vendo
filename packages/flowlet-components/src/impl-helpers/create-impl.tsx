import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";

/**
 * Wraps a render fn with schema validation. The agent (and the stub renderer,
 * which spreads raw node.props) can pass malformed props — validate here and
 * render an inline fallback instead of throwing or feeding garbage to OpenUI.
 */
export function createPrewiredImpl<S extends z.ZodType>(
  schema: S,
  renderValid: (props: z.infer<S>) => ReactNode,
): ComponentType<Record<string, unknown>> {
  function Impl(raw: Record<string, unknown>) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return <div data-testid="flowlet-invalid-props">Invalid component props</div>;
    }
    return <>{renderValid(parsed.data)}</>;
  }
  return Impl;
}
