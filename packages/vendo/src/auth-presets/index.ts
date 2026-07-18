/** 09-vendo §2.1 — host-identity presets: one config key (`createVendo({ auth })`)
    filling the principal, actAs, and oauth seams from a single identity story.
    Shipped on the umbrella's server entry. */
export { authJs } from "./auth-js.js";
// The three-seam conformance kit ships publicly (the @vendoai/core
// "./conformance" precedent): future named presets and host-custom presets are
// its consumers.
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
