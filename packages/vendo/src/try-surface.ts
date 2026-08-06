/**
 * `@vendoai/vendo/try-surface` — the try/playground surface as an importable,
 * CLIENT-ONLY React entry (HANDOFF oss-export).
 *
 * Both venues build from this one source: the CLI IIFE (the playground server
 * serves it at `/playground.js`) and a vendo-web Next client route. The import closure is
 * asserted client-only by `closure-guard` — it contains ONLY @vendoai/ui,
 * @vendoai/core, react, ai, and the app's own files, never the umbrella server
 * graph (@vendoai/store, @vendoai/actions, ./server,
 * createVendo) — which is exactly what lets Next compile it as a client route.
 *
 *   mount(el, options?)            — boot the surface (playground OR try) into el
 *   <PlaygroundApp/>               — the scripted playground shell
 *   <TrySurface config=…/>         — the hosted try surface (config-driven)
 *   mountScenario / mountLauncher  — the docs inline-embed drop-ins
 */
export {
  PlaygroundApp,
  TrySurface,
  mount,
  mountLauncher,
  mountScenario,
  type EmbedMountOptions,
  type MountOptions,
} from "./cli/playground/app/surface.js";
export type { TryBootConfig } from "./cli/playground/app/try-boot.js";
export type { TryProfile } from "./cli/try/profile.js";
