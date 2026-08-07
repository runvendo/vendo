/**
 * `guard(rules)` — the host's rules, declared standalone and completed by
 * whoever composes them.
 *
 * The same shape `vendo()` and `agent()` already use: a value a host writes at
 * boot, carrying only what a HOST can decide (policy, judge, approval
 * lifecycle) and none of the plumbing only a composition can supply (the store,
 * the risk resolver, the org-policy reader, the cloud policy fallback). The
 * venue finishes it through {@link createGuard} — the one and only constructor,
 * for both this path and a host that calls it directly.
 *
 * Like `defineHarness`, the function is identity: it exists for the authoring
 * vocabulary and the type inference, not for behaviour. `guard: { policy: … }`
 * is the same value.
 */
import type { GuardRules, VendoGuard } from "./types.js";

export function guard(rules: GuardRules = {}): GuardRules {
  return rules;
}

/**
 * Which arm of a `VendoGuard | GuardRules` slot this is. `bind` is the method
 * every guard implementation must have (it is how the one choke point is wired)
 * and no rules object can plausibly carry, so it is the honest discriminator —
 * the same test `isComposedAgent` makes on `session`.
 */
export const isGuardInstance = (
  value: VendoGuard | GuardRules | undefined,
): value is VendoGuard => typeof (value as VendoGuard | undefined)?.bind === "function";
