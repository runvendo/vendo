/** Complete headless hook surface (08-ui §3). */
export { useActivity } from "./use-activity.js";
export { useApp } from "./use-app.js";
export { useApps } from "./use-apps.js";
export { useApprovals } from "./use-approvals.js";
export { useAutomations } from "./use-automations.js";
export { useConnections } from "./use-connections.js";
export { useGrants } from "./use-grants.js";
// Deliberately public (lane pick 1-H): the ejected thread surface imports it,
// and hosts placing their own approval chrome need the same breakpoint truth.
export { useMobileTakeover, type MobileTakeover } from "./use-mobile-takeover.js";
export { type PollOptions } from "./use-resource.js";
export { useSlotApp } from "./use-slot-app.js";
export { useThreads } from "./use-threads.js";
export { useVendoOverlay, type VendoOverlayController } from "./use-vendo-overlay.js";
export { useVendoStatus } from "./use-vendo-status.js";
export { useVendoThread, type VendoThreadApproval } from "./use-vendo-thread.js";
export { ScriptedTransport, type DirectorCue, type DirectorScript } from "./scripted-transport.js";
