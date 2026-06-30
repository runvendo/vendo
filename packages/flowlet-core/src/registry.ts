import type { FlowletSchema } from "./schema";
import type { UINodeSource } from "./ui";

/** Descriptor only. Host-component *provisioning* is an F3a concern, not this. */
export interface RegisteredComponent {
  name: string;
  description: string;        // drives LLM selection
  propsSchema: FlowletSchema<unknown>;
  source: UINodeSource;
}

export interface ComponentRegistry {
  get(name: string): RegisteredComponent | undefined;
  list(): RegisteredComponent[];
}

export function createRegistry(components: RegisteredComponent[]): ComponentRegistry {
  const map = new Map(components.map((c) => [c.name, c]));
  return {
    get: (name) => map.get(name),
    list: () => [...map.values()],
  };
}
