/**
 * The fixed Vendo principal for the demo.
 *
 * `userId` scopes Composio's connected accounts. It must match the user that
 * authorized Gmail + Slack via `pnpm composio:connect` (see DEMO-RUNBOOK). An
 * empty userId makes Composio fail closed, so this is threaded through the chat
 * route into `agent.run({ principal })`.
 */
import type { VendoPrincipal } from "@vendoai/runtime";

export const DEMO_USER_ID = "vendo-demo";

export const DEMO_PRINCIPAL: VendoPrincipal = {
  userId: DEMO_USER_ID,
};
