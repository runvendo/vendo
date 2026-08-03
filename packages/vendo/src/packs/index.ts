/** Packs — the only way capability arrives (architecture §5). */
export { definePack } from "./define.js";
export { mergePacks, type AppsPackHandle, type MergedPacks, type PackContext } from "./merge.js";
export { toolsFromRegistry } from "./from-registry.js";
export { hostPackToolCollision, hostToolNamesIn, missingAppsPackWarning, vendoDirOf } from "./boot.js";
export { packComponents } from "./components.js";
export { apps, appsPackTools, APPS_PACK_NAME } from "./apps.js";
export { automations, AUTOMATIONS_PACK_NAME, UNATTENDED_IRREVERSIBILITY_RULE } from "./automations.js";
export { DEFAULT_PACKS } from "./defaults.js";
