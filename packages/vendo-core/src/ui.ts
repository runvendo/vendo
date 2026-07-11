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
}

export type UINode = ComponentNode | GeneratedNode;

export const isGeneratedNode = (n: UINode): n is GeneratedNode => n.kind === "generated";
