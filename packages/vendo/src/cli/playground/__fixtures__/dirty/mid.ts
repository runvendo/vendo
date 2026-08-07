// Fixture: a module that VALUE-imports the umbrella server graph. This is the
// exact regression the client-only invariant forbids.
import { createServerStore } from "@vendoai/store";

export const helper = createServerStore;
