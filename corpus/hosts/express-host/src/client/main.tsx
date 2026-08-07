import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VendoRoot } from "@vendoai/vendo/react";
import { VendoOverlay } from "@vendoai/ui/chrome";
import { App } from "./App.js";
import "./brand.css";

const relayTheme = {
  colors: {
    background: "#eef7f4",
    surface: "#ffffff",
    text: "#102f2a",
    muted: "#5a7771",
    accent: "#087f6f",
    accentText: "#ffffff",
    danger: "#dc2626",
    border: "#e2e8f0",
  },
  typography: {
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    baseSize: "16px",
  },
  radius: { small: "8px", medium: "16px", large: "24px" },
  density: "comfortable" as const,
  motion: "full" as const,
};

const root = document.getElementById("root");
if (root === null) throw new Error("Relay root element is missing");

createRoot(root).render(
  <StrictMode>
    <VendoRoot baseUrl="/api/vendo" theme={relayTheme} components={{}}>
      <App />
      <div id="relay-vendo-layer" aria-live="polite">
        <VendoOverlay />
      </div>
    </VendoRoot>
  </StrictMode>,
);
