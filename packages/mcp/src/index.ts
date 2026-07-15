/** @vendoai/mcp — the door (docs/contracts/10-mcp.md).
 *
 * Landed (wave-6 DOOR lane, 2026-07-13): door + OAuth adapter + MCP Apps shim
 * and tests are implemented. The public surface below is the contract's §1
 * verbatim; nothing else is exported from the root.
 */
export { createMcpDoor } from "./door.js";
export type { McpDoor, McpDoorConfig, McpRunContext } from "./door.js";
export type {
  HostOAuthAdapter,
  HostOAuthAuthorizeContext,
  HostOAuthConsentFlow,
  HostOAuthSessionContext,
} from "./oauth/adapter.js";
export type { AppsPort } from "./apps-port.js";
