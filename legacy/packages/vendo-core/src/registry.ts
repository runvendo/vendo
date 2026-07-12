import type { VendoSchema } from "./schema.js";
import type { UINodeSource } from "./ui.js";

/** Descriptor only. Host-component *provisioning* is an F3a concern, not this. */
export interface RegisteredComponent {
  name: string;
  description: string;        // drives LLM selection
  propsSchema: VendoSchema<unknown>;
  source: UINodeSource;
  /** Registry compatibility version. Unset means "1". */
  version?: string;
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
