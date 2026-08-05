import { VendoAppProvider, startFrameProtocol } from "@vendoai/kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyProvisionedBrand } from "./provision.js";

/**
 * The app's entry point — the ONE place the runtime is wired, so an agent
 * editing the app never has to think about any of it.
 *
 * Three things happen here and nowhere else: the host's brand is applied, the
 * app is mounted inside the single Vendo provider, and the frame protocol starts.
 */

const mount = document.getElementById("root")!;

// Brand FIRST. The tokens are CSS custom properties, so applying them before the
// first paint is what keeps a themed app from flashing Vendo's neutral defaults.
const address = applyProvisionedBrand();

createRoot(mount).render(
  <StrictMode>
    <VendoAppProvider {...address}>
      <App />
    </VendoAppProvider>
  </StrictMode>,
);

// The inner half of the frame protocol (blueprint §12.3): REPORT this surface's
// natural height to the embedding frame. The host's bounds win — it fits the
// report inside the min/max it configured, and this side never negotiates.
startFrameProtocol(mount);
