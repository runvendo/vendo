import { memoryStoreAdapter } from "@vendoai/core/conformance";

/** Canonical test-only StoreAdapter shared by block fixtures. */
export const createMemoryStore = memoryStoreAdapter;
export type MemoryStore = ReturnType<typeof memoryStoreAdapter>;
