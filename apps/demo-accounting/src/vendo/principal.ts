/**
 * The fixed Vendo principal for the Cadence demo.
 *
 * `userId` scopes Composio's connected accounts and MUST match the user that
 * authorized Gmail + Google Calendar via `pnpm composio:connect` (the shared
 * demo subject — verified ACTIVE for Gmail and Google Calendar). The signed-in
 * PERSONA is Maya Alvarez (see the accounting-demo design doc); she surfaces as
 * the display name in approval claims, while the Composio subject stays the
 * infrastructure identity underneath.
 */
import type { Principal } from "@vendoai/core";
import type { VendoPrincipal } from "@vendoai/runtime";

export const DEMO_USER_ID = "vendo-demo";

/** Display name for approval/grant claims — the app's signed-in persona. */
export const DEMO_USER_NAME = "Maya Alvarez";

export const DEMO_PRINCIPAL: VendoPrincipal = {
  userId: DEMO_USER_ID,
};

/**
 * The demo's Store-seam scope (ENG-193 §6.1/§6.2): one fixed tenant plus the
 * Composio-authorized subject. This dependency-free leaf lets the store,
 * policy, and consent handlers share the same scope.
 */
export const CADENCE_SCOPE: Principal = { tenantId: "cadence-demo", subject: DEMO_USER_ID };
