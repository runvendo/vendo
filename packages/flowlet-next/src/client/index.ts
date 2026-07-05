/**
 * Public API surface for `@flowlet/next/client` — the browser half of the
 * Next.js adapter: the FlowletRoot provider that wires the shipped shell
 * surfaces to the routes `createFlowletHandler()` serves.
 */

export const FLOWLET_NEXT_CLIENT_PACKAGE = "@flowlet/next/client";

export { FlowletRoot, type FlowletRootProps } from "./flowlet-root";
export { SandboxStage, type SandboxStageProps } from "./sandbox-stage";
export { createServerIntegrations } from "./integrations";
export { createServerFlowletStore } from "./server-store";
export { createRunQuery, type RunQuery } from "./run-query";
export { runConnectFlow, type ConnectOutcome } from "./connect-flow";
