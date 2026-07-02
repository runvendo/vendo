import type { ComponentType, ReactNode } from "react";
import { Component } from "react";
import type { z } from "zod";
import type { HostComponentDescriptor } from "./host-component";

const FALLBACK = <div data-testid="flowlet-invalid-props">Invalid component props</div>;

class HostImplBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  render(): ReactNode {
    return this.state.hasError ? FALLBACK : this.props.children;
  }
}

/** Runtime capabilities the stage injects per node — NOT part of the JSON
 *  props contract, so they are handed to the adapter separately. */
export interface HostImplRuntime {
  /** Per-node governed dispatch; absent outside the stage (stub renderer). */
  flowlet?: { dispatch: (d: { action: string; payload?: unknown }) => Promise<unknown> };
  nodeId?: string;
}

/**
 * Bind a host descriptor to its React adapter — the React half of the
 * registration path.
 *
 * The adapter receives (1) schema-validated JSON props and (2) the runtime
 * capabilities (`flowlet.dispatch`, node id) as a separate argument — they are
 * injected by the stage, not authored by the model, so they never appear in
 * the descriptor schema. Schema-invalid props render an inline fallback;
 * render-time throws are contained per node.
 */
export function bindHostImpl<S extends z.ZodType>(
  descriptor: HostComponentDescriptor & { propsSchema: S },
  adapt: (props: z.infer<S>, runtime: HostImplRuntime) => ReactNode,
): ComponentType<Record<string, unknown>> {
  function HostImpl(raw: Record<string, unknown>) {
    const parsed = descriptor.propsSchema.safeParse(raw);
    if (!parsed.success) return FALLBACK;
    const runtime: HostImplRuntime = {
      flowlet: raw.flowlet as HostImplRuntime["flowlet"],
      nodeId: typeof raw.__nodeId === "string" ? raw.__nodeId : undefined,
    };
    // Indirection so adapt() runs INSIDE the boundary's subtree — a throw
    // while constructing children would otherwise escape the boundary.
    const Adapted = () => <>{adapt(parsed.data, runtime)}</>;
    return (
      <HostImplBoundary>
        <Adapted />
      </HostImplBoundary>
    );
  }
  HostImpl.displayName = `FlowletHost(${descriptor.name})`;
  return HostImpl;
}
