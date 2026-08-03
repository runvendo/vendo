import { VendoError, type Harness } from "@vendoai/core";

/** The adapter slots a harness's `requires` can speak about. The SLOT being
 *  filled is the switch — there is no capability boolean anywhere (§9). */
export interface ComposedAdapters {
  sandbox?: unknown;
}

/**
 * Build-list item 5 — check `requires` at composition, never at runtime.
 * A spawned-CLI harness with no machine to live on is a wiring mistake the host
 * should hear about at boot, not a turn that dies in front of a user.
 */
export function assertHarnessComposable(harness: Harness, adapters: ComposedAdapters): void {
  if (harness.requires?.sandbox === true && adapters.sandbox === undefined) {
    throw new VendoError(
      "validation",
      `${harness.name} needs a sandbox adapter — pass one to createVendo({ sandbox }), `
        + `or choose a harness that runs in process.`,
    );
  }
}
