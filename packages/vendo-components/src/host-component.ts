import type { z } from "zod";
import type { RegisteredComponent, VendoSchema } from "@vendoai/core";
import { RESERVED_COMPONENT_NAMES } from "@vendoai/core";
import type { PrewiredDescriptor } from "./descriptor";

/** A host component's registration metadata. Same shape as PrewiredDescriptor
 *  (React-free, safe for server code) — only the stamped `source` differs,
 *  plus an optional registry compat version (ENG-186). */
export type HostComponentDescriptor = PrewiredDescriptor & { version?: string };

export interface HostComponentOptions {
  /** Registry compat version. Bump on a BREAKING change to the component's
   *  props or behavior — saved vendos stamp the version they were built
   *  against and warn on reopen when it moved. Unset means "1". */
  version?: string;
}

/**
 * Declare one of the HOST APP's own components for the agent's menu.
 *
 * This is the developer entrypoint of the registration path: give your
 * component a PascalCase name, an agent-facing description (this text is what
 * the model reads to decide when to use it — write it like docs), and a
 * JSON-safe zod props schema. Pair it with `bindHostImpl` (React side) to
 * produce the sandbox implementation.
 *
 * Fails fast at module-load time on names the genui format would reject —
 * a bad registration should break the build, not a render at runtime.
 */
export function hostComponent(
  name: string,
  description: string,
  propsSchema: z.ZodType,
  options: HostComponentOptions = {},
): HostComponentDescriptor {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(
      `hostComponent: "${name}" must be PascalCase ([A-Z][A-Za-z0-9]*) — the genui format resolves components by that name`,
    );
  }
  if ((RESERVED_COMPONENT_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `hostComponent: "${name}" is reserved for a prewired primitive — pick another name`,
    );
  }
  if (!description.trim()) {
    throw new Error(
      `hostComponent: "${name}" needs a non-empty description — it is the documentation the agent reads to pick components`,
    );
  }
  return {
    name,
    description,
    propsSchema,
    version: options.version,
    toRegistered: () => ({
      name,
      description,
      propsSchema: propsSchema as VendoSchema<unknown>,
      source: "host",
      ...(options.version !== undefined ? { version: options.version } : {}),
    }),
  };
}

/** Project a list of host descriptors to the F1 registry entries. */
export function toHostRegistry(descriptors: HostComponentDescriptor[]): RegisteredComponent[] {
  return descriptors.map((d) => d.toRegistered());
}
