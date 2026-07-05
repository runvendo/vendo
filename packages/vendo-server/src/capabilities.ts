/**
 * Capability-additive keys (the locked OSS install model):
 *   any one big-3 provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 *     GOOGLE_GENERATIVE_AI_API_KEY) alone → chat + generated UI fully working;
 *   +OPENAI_API_KEY        → voice capability flag (UX lands with ENG-185);
 *   +COMPOSIO_API_KEY      → integrations light up.
 *
 * A host that injects its own `model` (bringing its own credential) also
 * gets chat, regardless of which env keys are set — `hasInjectedModel` is the
 * other half of the chat gate alongside key presence. A configured
 * `VENDO_MODEL` alone is NOT enough: it names a model, not a credential, so
 * chat stays off until a real key (or an injected model) shows up.
 *
 * A missing key never errors — the capability simply reads `false` and the
 * client hides that surface.
 */
import { hasProviderKey, present } from "./model-choice.js";

export interface VendoCapabilities {
  chat: boolean;
  integrations: boolean;
  voice: boolean;
  /** True when the host declared ≥1 MCP server (set by the handler, not env). */
  mcp: boolean;
  /** True when the assembled handler built a durable storage handle (set by
   *  the handler from the resolved `storage` option, not env — see
   *  fetch-handler.ts's GET "capabilities" case). */
  storage: boolean;
}

/** What `detectCapabilities` alone can answer from env keys — everything on
 *  the wire shape except `storage` (the handler merges that in). */
export type EnvCapabilities = Omit<VendoCapabilities, "storage">;

export interface DetectCapabilitiesOptions {
  /** True when the host supplied its own `model` (e.g. via handler options). */
  hasInjectedModel?: boolean;
}

export function detectCapabilities(
  env: Record<string, string | undefined> = process.env,
  { hasInjectedModel = false }: DetectCapabilitiesOptions = {},
): EnvCapabilities {
  return {
    chat: hasInjectedModel || hasProviderKey(env),
    integrations: present(env["COMPOSIO_API_KEY"]),
    voice: present(env["OPENAI_API_KEY"]),
    // MCP is config-presence, not key-presence — the handler overrides this
    // from the resolved server list.
    mcp: false,
  };
}
