export type UINodeSource = "prewired" | "host" | "generated";

export interface ComponentNode {
  id: string;
  kind: "component";
  source: UINodeSource;
  name: string;
  props: unknown;
  children?: UINode[];
}

export interface GeneratedNode {
  id: string;
  kind: "generated";
  payload: unknown; // fully opaque in F1; format chosen by F3
  /** Set when the view was rendered in a FlowletRemix-scoped conversation:
   *  it is a remix candidate for that anchor (Apply pins it). */
  remixAnchorId?: string;
}

export type UINode = ComponentNode | GeneratedNode;

export const isComponentNode = (n: UINode): n is ComponentNode => n.kind === "component";
export const isGeneratedNode = (n: UINode): n is GeneratedNode => n.kind === "generated";
