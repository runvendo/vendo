/**
 * The fixed Flowlet principal for the Cadence demo.
 *
 * `userId` scopes Composio's connected accounts and MUST match the user that
 * authorized Gmail + Google Calendar via `pnpm composio:connect` (the shared
 * demo subject — verified ACTIVE for gmail/googlecalendar/slack). The signed-in
 * PERSONA is Maya Alvarez (see the accounting-demo design doc); she surfaces as
 * the display name in approval claims, while the Composio subject stays the
 * infrastructure identity underneath.
 */
import type { FlowletPrincipal } from "@flowlet/runtime";

export const DEMO_USER_ID = "flowlet-demo";

/** Display name for approval/grant claims — the app's signed-in persona. */
export const DEMO_USER_NAME = "Maya Alvarez";

export const DEMO_PRINCIPAL: FlowletPrincipal = {
  userId: DEMO_USER_ID,
};
