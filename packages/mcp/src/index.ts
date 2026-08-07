/** @vendoai/mcp — the door.
 *
 * Landed (wave-6 DOOR lane, 2026-07-13): door + OAuth adapter + MCP Apps shim
 * and tests are implemented. The public surface below is the retired v1
 * contract's §1 verbatim (in git history); nothing else is exported from the
 * root.
 */
export { createMcpDoor } from "./door.js";
/** The door's own resource canonicalization, exported so a composition seam
 *  declaring an external audience derives it the same way the door does. */
export { canonicalUri } from "./oauth/server.js";
export type { McpDoor, McpDoorConfig, McpRunContext } from "./door.js";
export type {
  HostOAuthAdapter,
  HostOAuthAuthorizeContext,
  HostOAuthConsentFlow,
  HostOAuthSessionContext,
} from "./oauth/adapter.js";
export type { AppsPort } from "./apps-port.js";
export { createTurnCredentials } from "./turn-credential.js";
export type {
  LiveTurn,
  TurnCredentialPort,
  TurnCredentials,
  TurnCredentialsOptions,
} from "./turn-credential.js";
