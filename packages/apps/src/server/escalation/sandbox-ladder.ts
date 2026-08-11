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
 * SELECTION LAW: env keys are credentials, config selects. `VENDO_API_KEY` is
 * the only blessed default-filler for a slot the host left unset — a
 * third-party provider key lying around in the environment selects nothing.
 *
 * Precedence, top to bottom:
 *   1. an explicitly passed adapter always wins (the hard BYO rule);
 *   2. VENDO_API_KEY defaults the Cloud managed pool, for a slot the caller
 *      left unset;
 *   3. nothing. What "nothing" MEANS belongs to the caller, and is the one
 *      thing the two consumers legitimately disagree about: the umbrella's
 *      dark venue (server apps answer sandbox-unavailable, chat is unaffected)
 *      versus the agent runtime's boot error naming both ways out.
 *
 * `E2B_API_KEY` is NOT a rung. It is a credential, consumed only by an explicit
 * `e2bSandbox()` when no `apiKey` was passed inline — so a stray key in a shell
 * can no longer flip a deployment's execution venue (0.4.4 defect C's real
 * cause), and the "is the SDK installed?" refusal lives where the host actually
 * chose e2b, in `e2bSandbox()` itself.
 *
 * The Cloud rung is a PARAMETER, not an env branch here, because its
 * implementation speaks the console wire and therefore ships in
 * `@vendoai/vendo`, which this package may not import. Unset, rung 2 simply
 * does not light — a build with no Cloud adapter has no Cloud sandbox.
 */
import type { SandboxAdapter } from "./sandbox.js";

/** Which rung answered — reported verbatim on the umbrella's /status. `"e2b"`
 *  is no longer produced by this function (an explicit `e2bSandbox()` is
 *  `"custom"` like any other host adapter); it stays in the union because
 *  /status readers still meet it on older wires. */
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

export function selectSandbox(
  configured: SandboxAdapter | undefined,
  cloud?: CloudSandboxRung,
): SandboxSelection {
  if (configured !== undefined) return { adapter: configured, venue: "custom" };

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
