import type { VendoSchema } from "./schema.js";
import type { UINodeSource } from "./ui.js";

/** Descriptor only. Host-component *provisioning* is an F3a concern, not this. */
export interface RegisteredComponent {
  name: string;
  description: string;        // drives LLM selection
  propsSchema: VendoSchema<unknown>;
  source: UINodeSource;
  /** Registry compat version (ENG-186). Host teams bump it on a breaking
   *  change to a component's props/behavior; saved vendos stamp it at save
   *  time and diff it on reopen to surface drift. Unset means "1". */
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
