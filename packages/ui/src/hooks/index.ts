/** Complete headless hook surface (08-ui §3). */
export { useActivity } from "./use-activity.js";
export { useApp } from "./use-app.js";
export { useApps } from "./use-apps.js";
export { useAppGrants } from "./use-app-grants.js";
export { useApprovals, useAttention } from "./use-approvals.js";
// LANE D §2/§3 — the shapes useAttention hands back (the finished-run headline
// the launcher toast and any host notification hook read).
export type { RunActivity, RunResult } from "../chrome/run-activity.js";
export { useAutomations } from "./use-automations.js";
export { useConnections } from "./use-connections.js";
export { useConnectorCatalog } from "./use-connector-catalog.js";
export { useGrants } from "./use-grants.js";
// Deliberately public (lane pick 1-H): the ejected thread surface imports it,
// and hosts placing their own approval chrome need the same breakpoint truth.
export { useApprovalSheetPresentation, useMobileTakeover, type MobileTakeover } from "./use-mobile-takeover.js";
export { type PollOptions } from "./use-resource.js";
export { useSlotApp } from "./use-slot-app.js";
export { useThreads } from "./use-threads.js";
export { useVendoOverlay, type VendoOverlayController } from "./use-vendo-overlay.js";
export { useVendoStatus } from "./use-vendo-status.js";
export { useVendoContext } from "./use-vendo-context.js";
export { useVendoThread, type VendoThreadApproval } from "./use-vendo-thread.js";
export { ScriptedTransport, type DirectorCue, type DirectorScript } from "./scripted-transport.js";
