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
 * INVARIANT: a non-blank ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, or
 * ANTHROPIC_BASE_URL in the passed env IS an own credential (the corporate-
 * gateway / custom-endpoint path Claude Code also supports, none of which
 * show up in a `claude auth status` login probe) and always wins, even if a
 * caller mistakenly passes `ownCredentialAvailable: false`. Overwriting a
 * dev's already-configured BYO endpoint would silently redirect their
 * inference through Vendo's gateway and bill their org's meter — this
 * module checks it directly rather than trusting callers to remember.
 *
 * The gateway must be able to refuse this traffic for free-plan orgs
 * (spec's free-plan policy), so every request gets tagged with the
 * INIT_PURPOSE_HEADER — a plain "name: value" line via Claude Code's
 * ANTHROPIC_CUSTOM_HEADERS mechanism. The constant is the single source of
 * truth; the console mirrors the literal in its own tests (plan Task 7).
 */

export const INIT_PURPOSE_HEADER_NAME = "x-vendo-purpose";
export const INIT_PURPOSE_HEADER_VALUE = "init";

/** Env vars that Claude Code itself accepts as an own credential besides
 *  ANTHROPIC_API_KEY and a CLI login: a corporate-gateway auth token, a
 *  device-flow OAuth token, or a custom base URL with no token at all
 *  (mTLS/proxy auth). None of these are visible to a `claude auth status`
 *  probe, so any caller folding "own credential" into its own predicate
 *  (claude-cli-harness.ts's availability()/run()) must check these three
 *  directly rather than relying solely on the login probe. Exported so
 *  every harness checks the identical set. */
export const OWN_CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

function nonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when the env alone (no async probe needed) already carries one of
 *  Claude Code's own-credential env vars (see OWN_CREDENTIAL_ENV_VARS). */
export function hasOwnAnthropicEnvOverride(env: Record<string, string | undefined>): boolean {
  return OWN_CREDENTIAL_ENV_VARS.some((name) => nonBlank(env[name]));
}

export interface GatewayFuelOverlay {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_CUSTOM_HEADERS: string;
}

export interface GatewayFuelOptions {
  /** The CHILD'S real env — i.e. the same merged {...process.env,
   *  ...input.env} the harness is about to spawn with, never the caller's
   *  partial input env alone. The INVARIANT above is only worth anything if
   *  it is checked against the env the subprocess will actually read: an
   *  ambient (process.env) ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL is a
   *  live BYO endpoint that an overlay composed from input.env alone would
   *  silently clobber. */
  env: Record<string, string | undefined>;
  /** True when the rung already has a working credential of its own (its
   *  own ANTHROPIC_API_KEY, a satisfied Claude Code login, ...). Each
   *  harness computes this itself — an env check, an async login probe,
   *  whatever its rung needs — and passes the verdict in, so this module
   *  stays a pure, harness-agnostic composition step reusable by every
   *  Claude-Code-shaped rung (claude-cli-harness.ts today; the future
   *  npx-engine harness reuses the same function). This module additionally
   *  checks OWN_CREDENTIAL_ENV_VARS itself regardless of this flag — see
   *  the module-level INVARIANT note. */
  ownCredentialAvailable: boolean;
}

/** Compose the gateway-fuel env overlay for a Claude-Code-shaped rung, or
 *  null when gateway fuel does not apply: own credential wins (either the
 *  caller's verdict or a directly-detected env override), or there is no
 *  VENDO_API_KEY to fuel with. */
export function composeGatewayFuel(options: GatewayFuelOptions): GatewayFuelOverlay | null {
  if (options.ownCredentialAvailable) return null;
  if (hasOwnAnthropicEnvOverride(options.env)) return null;
  const key = options.env["VENDO_API_KEY"];
  if (!nonBlank(key)) return null;
  const base = resolveCloudBaseUrl({ env: options.env });
  const baseURL = base.endsWith("/api/v1") ? base : `${base}/api/v1`;
  return {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_AUTH_TOKEN: key.trim(),
    ANTHROPIC_CUSTOM_HEADERS: `${INIT_PURPOSE_HEADER_NAME}: ${INIT_PURPOSE_HEADER_VALUE}`,
  };
}
