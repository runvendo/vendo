import { z } from "zod";
import type { RegisteredComponent, VendoSchema } from "@vendoai/core";

/** A registered component's metadata. React-free — safe for the descriptors entrypoint. */
export interface PrewiredDescriptor {
  name: string;
  description: string;
  propsSchema: z.ZodType;
  toRegistered(): RegisteredComponent;
}

export function prewired(
  name: string,
  description: string,
  propsSchema: z.ZodType,
): PrewiredDescriptor {
  return {
    name,
    description,
    propsSchema,
    toRegistered: () => ({
      name,
      description,
      propsSchema: propsSchema as VendoSchema<unknown>,
      source: "prewired",
    }),
  };
}

/** Recursive JSON value — the boundary every prop schema must stay within. */
export const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);
