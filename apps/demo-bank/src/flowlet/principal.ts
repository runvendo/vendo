/**
 * The fixed Flowlet principal for the demo.
 *
 * `userId` scopes Composio's connected accounts. It must match the user that
 * authorized Gmail + Slack via `pnpm composio:connect` (see DEMO-RUNBOOK). An
 * empty userId makes Composio fail closed, so this is threaded through the chat
 * route into `agent.run({ principal })`.
 */
import type { FlowletPrincipal } from "@flowlet/agent";

export const DEMO_USER_ID = "flowlet-demo";

export const DEMO_PRINCIPAL: FlowletPrincipal = {
  userId: DEMO_USER_ID,
};
