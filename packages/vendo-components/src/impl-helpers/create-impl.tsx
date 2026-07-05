import { Component, type ComponentType, type ReactNode } from "react";
import type { z } from "zod";

const FALLBACK = (
  <div data-testid="vendo-invalid-props">Invalid component props</div>
);

/** Error boundary that catches render-time throws from OpenUI or icon components. */
class ImplErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render(): ReactNode {
    if (this.state.hasError) return FALLBACK;
    return this.props.children;
  }
}

/**
 * Inner component that calls renderValid inside the error boundary's render
 * tree, so any throw from renderValid (or from OpenUI components) is caught
 * by the surrounding ImplErrorBoundary rather than propagating up.
 */
function ImplContent<T>({
  renderFn,
  data,
}: {
  renderFn: (d: T) => ReactNode;
  data: T;
}): ReactNode {
  return <>{renderFn(data)}</>;
}

/**
 * Wraps a render fn with schema validation. The agent (and the stub renderer,
 * which spreads raw node.props) can pass malformed props — validate here and
 * render an inline fallback instead of throwing or feeding garbage to OpenUI.
 * An error boundary ensures any render-time throw also shows the fallback
 * instead of crashing the host tree.
 */
export function createPrewiredImpl<S extends z.ZodType>(
  schema: S,
  renderValid: (props: z.infer<S>) => ReactNode,
): ComponentType<Record<string, unknown>> {
  function Impl(raw: Record<string, unknown>) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return FALLBACK;
    }
    return (
      <ImplErrorBoundary>
        <ImplContent renderFn={renderValid} data={parsed.data} />
      </ImplErrorBoundary>
    );
  }
  return Impl;
}
