/**
 * The docs inline-embed IIFE entry (vendo.run/playground/embed.js): wires the
 * pure `mountScenario`/`mountLauncher` from `./surface.js` onto `window` so a
 * host page can mount REAL chrome surfaces — scripted data, no model key —
 * directly into its DOM (no iframe). Built by scripts/build-playground.mjs into
 * embed-bundle.gen.ts; the CLI playground server and the vendo-web static
 * export both serve it as /embed.js.
 *
 *   window.VendoDocsEmbed.mount(el, { scenario: "approval-flow" })
 *   window.VendoDocsEmbed.mountLauncher()
 *
 * `mount` returns a dispose function. `mountLauncher` drops the real corner
 * launcher + overlay onto the page (the actual product drop-in) — one call,
 * one line to remove. The surface logic itself lives in the importable
 * `@vendoai/vendo/try-surface` module; this file only performs the window wiring
 * (a load-time side effect, kept out of the importable entry).
 */
import { mountLauncher, mountScenario } from "./surface.js";

declare global {
  interface Window {
    VendoDocsEmbed?: { mount: typeof mountScenario; mountLauncher: typeof mountLauncher };
  }
}

window.VendoDocsEmbed = { mount: mountScenario, mountLauncher };
// Host pages poll for readiness; give them an event too.
window.dispatchEvent(new Event("vendo-docs-embed-ready"));
