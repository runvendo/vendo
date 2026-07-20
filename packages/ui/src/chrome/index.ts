/** @vendoai/ui/chrome — the shipped, theme-adopting surfaces (08-ui §4). */
export { ActivityPanel } from "./activity-panel.js";
export { VendoActivities, type VendoActivitiesProps } from "./vendo-activities.js";
export { ApprovalCard, type ApprovalCardProps } from "./approval-card.js";
export { VendoAppEmbed, VendoApprovalEmbed, VendoToolResult } from "./embeds.js";
export { ApprovalSheet } from "./approval-sheet.js";
export { AutomationsPanel } from "./automations-panel.js";
export { ConnectCard, type ConnectCardProps } from "./connect-card.js";
export { ConnectedAccountsPanel } from "./connected-accounts-panel.js";
export { NoPolicyNotice } from "./no-policy-notice.js";
export { VendoOverlay, type VendoOverlayProps } from "./vendo-overlay.js";
export { defaultVendoGreeting, hasSeen, markSeen, type VendoDiscoverability, type VendoGreeting } from "./discoverability.js";
export { openVendoConversation, type OpenConversationOptions } from "./overlay-registry.js";
export { VendoTrigger, type VendoTriggerProps } from "./vendo-trigger.js";
export { VendoPage } from "./vendo-page.js";
export { VendoPalette, type VendoCommand } from "./vendo-palette.js";
export { type HotkeyChord, type PaletteHotkey } from "./palette-hotkey.js";
export { VendoSlot } from "./vendo-slot.js";
export { VendoThread, type VendoThreadProps } from "./thread/index.js";
export { VendoToasts, vendoToast, dismissAllVendoToasts, type VendoToastsProps, type VendoToastInput, type VendoToastAction } from "./vendo-toasts.js";
export { WaitingQueue, type WaitingQueueProps } from "./waiting-queue.js";
export { VendoStage } from "../voice/stage.js";

/** The eject surface: internals the ejected thread compiles against
    (scripts/eject-templates-lib.mjs enforces this list at build). Exported
    deliberately — ejected chrome keeps data/wire logic as a package
    dependency and only forks pixels (§4 customization ladder). */
export { ActivityLedger } from "./activity-ledger.js";
export {
  describeActivity,
  formatAuditTime,
  formatRelativeAuditTime,
  kindGlyph,
  outcomeLabel,
  type ActivityGlyph,
  type OutcomeTone,
} from "./activity-semantics.js";
export { BuildBeat, StatusRibbon, toolPresentation } from "./build-beat.js";
export { ChromeRoot } from "./chrome-root.js";
export { useCopyFeedback } from "./clipboard.js";
export { ConnectDockButton, ConnectTray } from "./connect-dock.js";
export { FluidThinking } from "./fluid-thinking.js";
export { previewArgs, toolTitle } from "./humanize.js";
export { Markdown } from "./markdown.js";
export { ACTIVITY_ANCHOR_ATTRIBUTE, ACTIVITY_BUMP_EVENT, MorphToast, type MorphToastProps } from "./morph-toast.js";
export { PrefillScopeContext, registerPrefillConsumer } from "./overlay-registry.js";
export { LONG_TEXT_CAP, truncateHead } from "./truncate.js";
