/** 09-vendo §2.1 — host-identity presets: one config key (`createVendo({ auth })`)
    filling the principal, actAs, and oauth seams from a single identity story.
    The five zero-arg preset FUNCTIONS do NOT ship from this barrel — each has
    its own subpath (@vendoai/vendo/auth/<name>) instead. A bundler resolves
    every `export ... from` target in a barrel file regardless of which named
    export a consumer actually uses, so combining all five here (as before
    corpus-triage Task 9) meant any host importing even one preset — or none —
    forced every preset's optional peer dep (jose/@auth/core/@clerk/backend) to
    resolve, breaking builds for hosts lacking one. Only the conformance kit and
    the shared types (erased before any bundler sees them) stay on this barrel;
    server.ts re-exports both from here unchanged. */
export {
  hostAuthPresetConformance,
  type HostAuthPresetConformanceOptions,
} from "./conformance.js";
export type {
  HostAuthPreset,
  HostAuthPresetOptions,
  HostAuthPresetUser,
  HostAuthPresetUserResolver,
} from "./shared.js";
export type { SupabaseHostAuthPresetOptions } from "./supabase.js";
