/**
 * The try surface's LIVE slot: the same overlay chrome as the scripted slot,
 * wired to the real vendo wire the try server mounts at the boot config's
 * `apiBase`.
 *
 * The composition deliberately mirrors a customer's app, seam for seam: a
 * `createVendoClient({ baseUrl })` and NO transport override, so
 * useVendoThread builds its own DefaultChatTransport against
 * `${apiBase}/threads` — the exact code path a host's production drop-in
 * exercises, not a parallel one. Collection hooks need no special casing
 * either: the try server mounts the FULL `createVendo().handler`, so threads,
 * apps, activity, and the connector catalog all answer from the real wire
 * (a fresh store means honest empty states, and a catalog failure hides the
 * connect dock fail-soft — see useConnectorCatalog). Wire trouble mid-session
 * (5xx, stream errors) surfaces through the chrome's own error states; there
 * is NO fallback to scripted data here — that would fake a working agent.
 *
 * Product-stage shell: the overlay opens at boot on the try panel landing
 * (greet + capability line + chips, try-panel.tsx); a chip press delivers its
 * prompt to the REAL composer and sends it over the live wire through
 * openVendoConversation — the same seam the scripted slot rides.
 */
import type { VendoTheme } from "@vendoai/core";
import { createVendoClient, VendoProvider, type ToolMetaMap } from "@vendoai/ui";
import { VendoOverlay } from "@vendoai/ui/chrome";
import { useMemo } from "react";
import { TryPanelThread } from "./try-panel.js";

export function LiveSurfaceMount({ apiBase, theme, tools }: {
  apiBase: string;
  theme: VendoTheme;
  /** Provider tool meta derived from the profile (liveToolMeta in try-boot). */
  tools: ToolMetaMap;
}) {
  const client = useMemo(() => createVendoClient({ baseUrl: apiBase }), [apiBase]);
  // Mirrors the scripted slot's stance: open at boot on the panel landing.
  // Discoverability quiet: the panel's product-named greeting IS the landing —
  // the chrome's fire-once tutorial would replace it (and burn the visitor's
  // localStorage flag) on first open.
  return (
    <VendoProvider client={client} theme={theme} tools={tools}>
      <VendoOverlay defaultOpen discoverability="quiet" thread={TryPanelThread} />
    </VendoProvider>
  );
}
