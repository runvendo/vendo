import type { UINode } from "@flowlet/core";
import { useShell } from "../context";

export interface UINodeViewProps {
  node: UINode;
}

export function UINodeView({ node }: UINodeViewProps) {
  const { renderNode } = useShell();
  return <div className="fl-uinode" data-testid="ui-node">{renderNode(node)}</div>;
}
