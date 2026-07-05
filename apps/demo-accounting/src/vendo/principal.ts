/**
 * The fixed Vendo principal for the Cadence demo.
 *
 * `userId` scopes Composio's connected accounts and MUST match the user that
 * authorized Gmail + Google Calendar via `pnpm composio:connect` (the shared
 * demo subject — verified ACTIVE for gmail/googlecalendar/slack). The signed-in
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
 * The demo's Store-seam scope (ENG-193 §6.1/§6.2): one fixed tenant + the
 * Composio-authorized subject. Defined here (a dependency-free leaf) rather
 * than in `automations.ts` (which re-exports it for compatibility) so that
 * `store.ts` can depend on it WITHOUT depending on `automations.ts` — that
 * indirection would create a module cycle once `policy.ts` (ENG-193 item 2)
 * imports `demoStore` from `store.ts`: `policy → store → automations →
 * policy`, deadlocking mid-initialization. Routing through this leaf module
 * breaks the cycle.
 */
export const CADENCE_SCOPE: Principal = { tenantId: "cadence-demo", subject: DEMO_USER_ID };
