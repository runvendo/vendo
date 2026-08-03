import type { PackProvider } from "@vendoai/core";
import { apps } from "./apps.js";
import type { PackContext } from "./merge.js";

/**
 * `packs:` unset means `[apps()]` (config §10). App generation is what Vendo is
 * for, so it is on by default; every other pack — ours or a third party's — is
 * something the host asks for by name.
 */
export const DEFAULT_PACKS: readonly PackProvider<PackContext>[] = [apps()];
