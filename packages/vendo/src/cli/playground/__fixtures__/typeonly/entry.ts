// Fixture: a type-only import of a server-graph package is erased at build and
// never enters the runtime closure, so the guard must NOT flag it.
import type { ServerStore } from "@vendoai/store";

export type Reexport = ServerStore;
export const value = 1;
