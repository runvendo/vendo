/**
 * The fixed Vendo principal for the Gmail-clone demo. `userId` must match
 * the user that authorized Slack via `pnpm composio:connect` (vendo-demo —
 * same identity demo-bank uses), so the Slack summary tool posts through the
 * already-verified connected account.
 */
import type { VendoPrincipal } from "@vendoai/runtime";

export const DEMO_USER_ID = "vendo-demo";

export const DEMO_PRINCIPAL: VendoPrincipal = {
  userId: DEMO_USER_ID,
};
