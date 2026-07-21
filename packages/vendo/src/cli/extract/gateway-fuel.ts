import { resolveCloudBaseUrl } from "../cloud/client.js";

/**
 * Gateway fuel: the env overlay that makes Claude Code (any rung that reads
 * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_CUSTOM_HEADERS — the
 * PATH `claude` binary today, the npx-fetched engine package tomorrow, per
 * `docs/superpowers/plans/2026-07-20-init-selfcontained-engine.md` Task 3/4)
 * speak to the Vendo Cloud model gateway instead of Anthropic directly, when
 * the dev has no Anthropic credential of their own but does have
 * VENDO_API_KEY. Own credential always wins — this module never overrides
 * it, and callers must never call it when one is available.
 *
 * The gateway must be able to refuse this traffic for free-plan orgs
 * (spec's free-plan policy), so every request gets tagged with the
 * INIT_PURPOSE_HEADER — a plain "name: value" line via Claude Code's
 * ANTHROPIC_CUSTOM_HEADERS mechanism. The constant is the single source of
 * truth; the console mirrors the literal in its own tests (plan Task 7).
 */

export const INIT_PURPOSE_HEADER_NAME = "x-vendo-purpose";
export const INIT_PURPOSE_HEADER_VALUE = "init";

export interface GatewayFuelOverlay {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_CUSTOM_HEADERS: string;
}

export interface GatewayFuelOptions {
  env: Record<string, string | undefined>;
  /** True when the rung already has a working credential of its own (its
   *  own ANTHROPIC_API_KEY, a satisfied Claude Code login, ...). Each
   *  harness computes this itself — an env check, an async login probe,
   *  whatever its rung needs — and passes the verdict in, so this module
   *  stays a pure, harness-agnostic composition step reusable by every
   *  Claude-Code-shaped rung (claude-cli-harness.ts today; the future
   *  npx-engine harness reuses the same function). */
  ownCredentialAvailable: boolean;
}

/** Compose the gateway-fuel env overlay for a Claude-Code-shaped rung, or
 *  null when gateway fuel does not apply: own credential wins, or there is
 *  no VENDO_API_KEY to fuel with. */
export function composeGatewayFuel(options: GatewayFuelOptions): GatewayFuelOverlay | null {
  if (options.ownCredentialAvailable) return null;
  const key = options.env["VENDO_API_KEY"];
  if (typeof key !== "string" || key.trim().length === 0) return null;
  const base = resolveCloudBaseUrl({ env: options.env });
  const baseURL = base.endsWith("/api/v1") ? base : `${base}/api/v1`;
  return {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_CUSTOM_HEADERS: `${INIT_PURPOSE_HEADER_NAME}: ${INIT_PURPOSE_HEADER_VALUE}`,
  };
}
