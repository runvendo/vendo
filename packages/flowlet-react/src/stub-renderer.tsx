import type { ComponentType } from "react";
import { isComponentNode, type UINode } from "@flowlet/core";
import { useFlowletContext } from "./provider";

/**
 * NON-PRODUCTION, NO SECURITY BOUNDARY. Renders component nodes from the registry
 * directly in the host tree, and a placeholder for generated nodes. The real
 * sandboxed stage replaces this in F3. API kept close to the future stage seam.
 */
export interface StubRendererProps {
  node: UINode;
  /** Optional map of component name -> React component for the example/tests. */
  impls?: Record<string, ComponentType<Record<string, unknown>>>;
}

export function StubRenderer({ node, impls = {} }: StubRendererProps) {
  const { registry } = useFlowletContext();

  if (isComponentNode(node)) {
    const known = registry.get(node.name);
    const Impl = impls[node.name];
    if (!known) return <div data-testid="unknown-node">Unknown component: {node.name}</div>;
    if (!Impl) return <div data-testid="unimpl-node">{node.name} (no impl)</div>;
    return (
      <div data-testid="component-node">
        <Impl {...(node.props as Record<string, unknown>)} />
      </div>
    );
  }

  return <div data-testid="generated-placeholder">[generated UI — rendered in the F3 sandbox]</div>;
}
