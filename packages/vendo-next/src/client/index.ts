/**
 * Public API surface for `@vendoai/next/client` — the browser half of the
 * Next.js adapter: the VendoRoot provider that wires the shipped shell
 * surfaces to the routes `createVendoHandler()` serves.
 */

export const VENDO_NEXT_CLIENT_PACKAGE = "@vendoai/next/client";

export { VendoRoot, type VendoRootProps } from "./vendo-root";
export { SandboxStage, type SandboxStageProps } from "./sandbox-stage";
export { createServerIntegrations } from "./integrations";
export { createServerVendoStore } from "./server-store";
export { createRunQuery, type RunQuery } from "./run-query";
export { runConnectFlow, type ConnectOutcome } from "./connect-flow";
export { createVendoVoice, type CreateVendoVoiceOptions } from "./voice";
