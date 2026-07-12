import type { Guard, StoreAdapter, ToolRegistry } from "@vendoai/core";
import type { HostOAuthAdapter } from "./oauth/adapter.js";
import type { AppsPort } from "./apps-port.js";

/** 10-mcp §1. */
export interface McpDoorConfig {
  /** ALREADY guard-bound by the umbrella (05 §2) — the door never sees an unbound registry. */
  tools: ToolRegistry;
  /** Audit reporting for auth events (§3); tool decisions happen inside the bound registry. */
  guard: Guard;
  /** §3 — two functions; the host owns identity + consent, the door owns the protocol. */
  oauth: HostOAuthAdapter;
  /** Door-owned protocol state (clients, codes, refresh grants) — wired like every other block. */
  store: StoreAdapter;
  /** §4 — saved apps ride along as MCP Apps; absent → tools-only door. */
  apps?: AppsPort;
}

export interface McpDoor {
  /** One fetch-style handler serving: MCP Streamable HTTP transport, the OAuth
   * endpoints (§3), and the discovery documents (§5). The umbrella mounts it. */
  handler: (req: Request) => Promise<Response>;
}

export function createMcpDoor(config: McpDoorConfig): McpDoor {
  void config;
  // Wave-6 DOOR lane: implement per docs/contracts/10-mcp.md.
  throw new Error("@vendoai/mcp: not yet implemented (wave-6 DOOR lane)");
}
