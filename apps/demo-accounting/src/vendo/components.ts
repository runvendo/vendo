/**
 * The component registry every Cadence Vendo surface shares: the prewired
 * catalog plus the two REGISTERED host components (CadenceStatusBadge,
 * CadenceDocProgress — see host-components/). Passed to VendoProvider/
 * VendoStage (validates generated host-node props) and read by the agent's
 * system prompt (the HOST COMPONENTS catalog). React-free — safe to import
 * server-side.
 */
import type { RegisteredComponent } from "@vendoai/core";
import { prewiredComponents } from "@vendoai/components/descriptors";
import { cadenceHostComponents } from "./host-components/descriptors";

export { cadenceHostComponents };

export const cadenceComponents: RegisteredComponent[] = [
  ...prewiredComponents,
  ...cadenceHostComponents,
];
