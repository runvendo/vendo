/**
 * Seal-key sourcing for the remix envelope (remix fast-edits spec):
 * `sealSecret` handler option, else `FLOWLET_SEAL_SECRET`, else HKDF from
 * `ANTHROPIC_API_KEY` — but ONLY on the default-model path (a host that
 * injects its own model owns its keys; we never assume the Anthropic key is
 * meaningful there). No material → sealing off: envelopes are not minted and
 * `base:"pin"` is never offered, while `base:"anchor"` keeps working.
 */
import { createRemixSealer, deriveSealKey, type RemixSealer } from "@flowlet/runtime";

export interface SealSourceInput {
  /** Explicit handler option (wins). */
  sealSecret?: string | undefined;
  /** True when the host injected its own `model`. */
  hasInjectedModel: boolean;
  /** Injectable for tests. */
  env?: Record<string, string | undefined>;
}

export function resolveRemixSealer(input: SealSourceInput): RemixSealer | undefined {
  const env = input.env ?? process.env;
  const key = deriveSealKey({
    secret: input.sealSecret ?? env["FLOWLET_SEAL_SECRET"],
    providerKey: input.hasInjectedModel ? undefined : env["ANTHROPIC_API_KEY"],
  });
  return key ? createRemixSealer(key) : undefined;
}
