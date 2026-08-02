import type { VendoTheme } from "@vendoai/core";
import type { HostFixture, HostName } from "../runner/types";

/**
 * The empty host fixture: no catalog, no tools, no data. It exists for the CLI's
 * fake-lane mode and for unit tests that exercise the runner/panes without a
 * generation surface. The real surfaces are maple.ts / cadence.ts.
 *
 * The theme is a complete VendoTheme because HostFixture promises one — the
 * /embed/<host> documents hand it straight to VendoProvider, so a partial
 * stand-in here would be the same lie the old client-side fixture told.
 */
export const stubTheme: VendoTheme = {
  colors: {
    background: "#ffffff",
    surface: "#f7f7f8",
    text: "#1a1a1e",
    muted: "#6b6b76",
    accent: "#111111",
    accentText: "#ffffff",
    danger: "#c62f2f",
    border: "#e3e3e8",
  },
  typography: { fontFamily: "system-ui, sans-serif", baseSize: "15px" },
  radius: { small: "6px", medium: "10px", large: "16px" },
  density: "comfortable",
  motion: "full",
};

export function stubHostFixture(name: HostName, overrides: Partial<HostFixture> = {}): HostFixture {
  return {
    name,
    catalog: {},
    tools: [],
    shapes: {},
    theme: stubTheme,
    execute: async () => ({}),
    ...overrides,
  };
}
