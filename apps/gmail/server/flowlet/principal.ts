/**
 * The fixed Flowlet principal for the Gmail-clone demo. `userId` must match
 * the user that authorized Slack via `pnpm composio:connect` (flowlet-demo —
 * same identity demo-bank uses), so the Slack summary tool posts through the
 * already-verified connected account.
 */
import type { FlowletPrincipal } from "@flowlet/runtime";

export const DEMO_USER_ID = "flowlet-demo";

export const DEMO_PRINCIPAL: FlowletPrincipal = {
  userId: DEMO_USER_ID,
};
