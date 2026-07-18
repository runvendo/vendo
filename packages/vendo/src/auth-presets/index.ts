/** 09-vendo §2.1 — host-identity presets: one config key (`createVendo({ auth })`)
    filling the principal, actAs, and oauth seams from a single identity story.
    Shipped on the umbrella's server entry. */
export { authJs } from "./auth-js.js";
export type {
  HostAuthPreset,
  HostAuthPresetOptions,
  HostAuthPresetUser,
  HostAuthPresetUserResolver,
} from "./shared.js";
