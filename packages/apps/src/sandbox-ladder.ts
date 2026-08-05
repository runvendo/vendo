/**
 * ADAPTER RULE, sandbox seam — THE ladder, and the only copy of it.
 *
 * Which `SandboxAdapter` composes is decided here, once, for every consumer:
 * the umbrella (`createVendo({ sandbox })`) and the standalone agent runtime
 * (`agent({ sandbox })`) call this same function. It lives in `@vendoai/apps`
 * because apps owns the sandbox seam and the e2b adapter, and because it is
 * the lowest package BOTH consumers may depend on — nothing in `@vendoai/agents`
 * may import `@vendoai/vendo` (the agents-v0 dependency law).
 *
 * Precedence, top to bottom:
 *   1. an explicitly passed adapter always wins (the hard BYO rule);
 *   2. E2B_API_KEY, the BYO sandbox env — but only when the optional `e2b` SDK
 *      is actually loadable. Half a BYO sandbox is a MISCONFIG, not a
 *      fallback: silently riding Cloud (or going dark) hides the missing
 *      install until the first box boot dies somewhere else entirely (0.4.4
 *      defect C). Trimmed, because a whitespace-only value is not a key —
 *      `vendo doctor`'s E-LIVE-007 check trims before deciding one is present,
 *      and disagreeing with doctor about whether the operator set a key means
 *      one of them is lying to the operator;
 *   3. VENDO_API_KEY defaults the Cloud managed pool, for a slot the caller
 *      left unset and with no BYO sandbox env present — so a Vendo key never
 *      shadows an existing provider account;
 *   4. nothing. What "nothing" MEANS belongs to the caller, and is the one
 *      thing the two consumers legitimately disagree about: the umbrella's
 *      dark venue (server apps answer sandbox-unavailable, chat is unaffected)
 *      versus the agent runtime's boot error naming every way out.
 *
 * The Cloud rung is a PARAMETER, not an env branch here, because its
 * implementation speaks the console wire and therefore ships in
 * `@vendoai/vendo`, which this package may not import. Unset, rung 3 simply
 * does not light — a build with no Cloud adapter has no Cloud sandbox.
 */
import { VendoError } from "@vendoai/core";
import { e2bInstalled, e2bSandbox } from "./e2b/index.js";
import type { SandboxAdapter } from "./sandbox.js";

/** Which rung answered — reported verbatim on the umbrella's /status. */
export type SandboxVenue = "e2b" | "cloud" | "custom" | false;

export interface SandboxSelection {
  adapter: SandboxAdapter | undefined;
  venue: SandboxVenue;
}

/** The Cloud rung: a factory over the console credential, never an adapter
 *  that reads the environment itself. */
export type CloudSandboxRung = (options: { apiKey: string; baseUrl?: string }) => SandboxAdapter;

const environment = (name: string): string | undefined => {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/** Operator knob for the provider machine lifetime: the adapter's default
 *  5-minute TTL kills a box mid-way through a long in-box agent build.
 *  Explicit VENDO_E2B_TIMEOUT_MS wins; otherwise a raised box-edit budget
 *  implies a matching machine lifetime (budget + 5-minute slack), so the two
 *  knobs cannot silently disagree. */
const e2bTimeoutMs = (): number | undefined => {
  const configured = Number(environment("VENDO_E2B_TIMEOUT_MS"));
  if (Number.isFinite(configured) && configured > 0) return configured;
  const editBudget = Number(environment("VENDO_BOX_EDIT_TIMEOUT_MS"));
  return Number.isFinite(editBudget) && editBudget > 0 ? editBudget + 5 * 60_000 : undefined;
};

export function selectSandbox(
  configured: SandboxAdapter | undefined,
  cloud?: CloudSandboxRung,
): SandboxSelection {
  if (configured !== undefined) return { adapter: configured, venue: "custom" };

  const e2bApiKey = environment("E2B_API_KEY");
  if (e2bApiKey !== undefined) {
    if (!e2bInstalled()) {
      throw new VendoError(
        "validation",
        "E2B_API_KEY is set but the e2b package is not installed — install e2b, or unset E2B_API_KEY to use another sandbox",
      );
    }
    const timeoutMs = e2bTimeoutMs();
    return {
      adapter: e2bSandbox({ apiKey: e2bApiKey, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      venue: "e2b",
    };
  }

  const apiKey = environment("VENDO_API_KEY");
  if (apiKey !== undefined && cloud !== undefined) {
    const baseUrl = environment("VENDO_CLOUD_URL");
    return {
      adapter: cloud({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) }),
      venue: "cloud",
    };
  }

  return { adapter: undefined, venue: false };
}
