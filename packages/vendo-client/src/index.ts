/**
 * Public API surface for `@vendoai/client` — the batteries-included browser
 * half of Vendo: the VendoRoot provider that wires the shipped shell
 * surfaces to the routes `createVendoHandler()` serves.
 */

export const VENDO_CLIENT_PACKAGE = "@vendoai/client";

export { VendoRoot, type VendoRootProps } from "./vendo-root.js";
export { SandboxStage, type SandboxStageProps } from "./sandbox-stage.js";
export { createServerIntegrations } from "./integrations.js";
export { createServerVendoStore } from "./server-store.js";
export { createRunQuery, type RunQuery } from "./run-query.js";
export { runConnectFlow, type ConnectOutcome } from "./connect-flow.js";
export { createVendoVoice, type CreateVendoVoiceOptions } from "./voice.js";
