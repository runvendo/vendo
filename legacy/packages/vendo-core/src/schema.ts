import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Vendo contracts type schema fields against the Standard Schema interface
 * (Zod/Valibot/ArkType all implement it). Zod is Vendo's default impl. Used by the
 * component registry's `propsSchema`; tool input schemas are typed by the ai SDK.
 */
export type VendoSchema<T> = StandardSchemaV1<T>;
