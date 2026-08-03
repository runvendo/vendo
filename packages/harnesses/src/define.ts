import type { Harness } from "@vendoai/core";

/**
 * Build contract §1 — returns the harness value itself. A harness that needs
 * host dependencies is authored as a plain factory returning that value
 * (`export const acmeHarness = (deps) => defineHarness({...})`); there is no
 * separate factory concept in the contract, so there is nothing to wrap.
 *
 * The function exists for the type inference and the authoring vocabulary, not
 * for behaviour: identity is the whole implementation, deliberately.
 */
export function defineHarness<Options = unknown>(def: Harness<Options>): Harness<Options> {
  return def;
}
