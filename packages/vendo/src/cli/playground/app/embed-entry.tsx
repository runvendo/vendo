/**
 * The docs inline-embed entry (vendo.run/playground/embed.js): mounts REAL
 * chrome surfaces — scripted data, no model key — directly into a host page's
 * DOM (no iframe). Built by scripts/build-playground.mjs into
 * embed-bundle.gen.ts; the CLI playground server and the vendo-web static
 * export both serve it as /embed.js.
 *
 *   window.VendoDocsEmbed.mount(el, { scenario: "approval-flow" })
 *   window.VendoDocsEmbed.mountLauncher()
 *
 * `mount` returns a dispose function. `mountLauncher` drops the real corner
 * launcher + overlay onto the page (the actual product drop-in) — one call,
 * one line to remove.
 */
import { defaultVendoTheme } from "@vendoai/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ScenarioMount } from "./scenario-mount.js";
import { scenarios } from "./scenarios.js";
import { decodeThemeParam } from "./theme-state.js";

interface MountOptions {
  /** Scenario id from the playground registry (e.g. "approval-flow"). */
  scenario: string;
  /** Optional encoded theme (the playground's ?theme= format). */
  theme?: string;
}

function mount(el: HTMLElement, options: MountOptions): () => void {
  const scenario = scenarios.find((entry) => entry.id === options.scenario);
  if (!scenario) {
    const known = scenarios.map((entry) => entry.id).join(", ");
    throw new Error(`[vendo-embed] unknown scenario "${options.scenario}" — one of: ${known}`);
  }
  const theme = decodeThemeParam(options.theme ?? null) ?? defaultVendoTheme;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <ScenarioMount scenario={scenario} theme={theme} root={el} />
    </StrictMode>,
  );
  return () => root.unmount();
}

/** The real product drop-in: corner launcher pill + overlay, scripted data. */
function mountLauncher(options: { theme?: string } = {}): () => void {
  const host = document.createElement("div");
  host.dataset.vendoDocsLauncher = "";
  document.body.append(host);
  const dispose = mount(host, { scenario: "overlay-launcher", theme: options.theme });
  return () => {
    dispose();
    host.remove();
  };
}

declare global {
  interface Window {
    VendoDocsEmbed?: { mount: typeof mount; mountLauncher: typeof mountLauncher };
  }
}

window.VendoDocsEmbed = { mount, mountLauncher };
// Host pages poll for readiness; give them an event too.
window.dispatchEvent(new Event("vendo-docs-embed-ready"));
