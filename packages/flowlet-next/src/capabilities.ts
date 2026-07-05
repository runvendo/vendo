/**
 * Capability-additive keys (the locked OSS install model):
 *   ANTHROPIC_API_KEY alone → chat + generated UI fully working;
 *   +COMPOSIO_API_KEY      → integrations light up;
 *   +OPENAI_API_KEY        → voice capability flag (UX lands with ENG-185).
 *
 * A missing key never errors — the capability simply reads `false` and the
 * client hides that surface.
 */

export interface FlowletCapabilities {
  chat: boolean;
  integrations: boolean;
  voice: boolean;
  /** True when the host declared ≥1 MCP server (set by the handler, not env). */
  mcp: boolean;
}

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function detectCapabilities(
  env: Record<string, string | undefined> = process.env,
): FlowletCapabilities {
  return {
    chat: present(env["ANTHROPIC_API_KEY"]),
    integrations: present(env["COMPOSIO_API_KEY"]),
    voice: present(env["OPENAI_API_KEY"]),
    // MCP is config-presence, not key-presence — the handler overrides this
    // from the resolved server list.
    mcp: false,
  };
}
