import type { animate } from "motion";

/** The lazily-loaded motion toolkit for the reveal layer. */
export interface FluidMotion {
  animate: typeof animate;
  /** Resolved via fluidkit's static-safe semantics: unknown (SSR) → true. */
  prefersReducedMotion: () => boolean;
}

// One load per session, shared by every reveal slot. `null` = unavailable
// (either library failed to load) — the enhancement layer simply stays off.
let pending: Promise<FluidMotion | null> | undefined;
let loaded: FluidMotion | null = null;

export function loadFluidMotion(): Promise<FluidMotion | null> {
  if (!pending) {
    pending = Promise.all([import("motion"), import("fluidkit")]).then(
      ([motionMod, fluidMod]): FluidMotion => {
        loaded = {
          animate: motionMod.animate,
          prefersReducedMotion: () => {
            const raw =
              typeof matchMedia !== "undefined"
                ? matchMedia("(prefers-reduced-motion: reduce)").matches
                : null;
            return fluidMod.resolvePrefersReducedMotion(raw);
          },
        };
        return loaded;
      },
      () => null,
    );
  }
  return pending;
}

/** Synchronous peek: the toolkit if it already finished loading, else null. */
export function loadedFluidMotion(): FluidMotion | null {
  return loaded;
}
