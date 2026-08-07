/** @vendoai/ui/chrome — the shipped, theme-adopting surfaces (08-ui §4). */
export { ActivityPanel } from "./activity-panel.js";
export { VendoActivities, type VendoActivitiesProps } from "./vendo-activities.js";
export { ApprovalCard, type ApprovalCardProps } from "./approval-card.js";
export { VendoAppEmbed, VendoApprovalEmbed, VendoToolResult } from "./embeds.js";
export { ApprovalSheet } from "./approval-sheet.js";
export { AutomationCard, sponsorLabel, type AutomationCardProps } from "./automation-card.js";
export { GrantSetCard, type GrantSetCardProps, type GrantSetPermission } from "./grant-set-card.js";
export { AutomationsPanel } from "./automations-panel.js";
export { ConnectCard, type ConnectCardProps } from "./connect-card.js";
export { ConnectedAccountsPanel } from "./connected-accounts-panel.js";
// Build contract §9.2-§9.6 — the one surface that writes app-access grants,
// and the consumer-voice fork offer a viewer sees instead of a refusal.
export {
  ForkOffer,
  ShareDialog,
  encodeGrantPrincipal,
  type ForkOfferProps,
  type ShareDialogProps,
} from "./share-dialog.js";
export { NoPolicyNotice } from "./no-policy-notice.js";
export { VendoOverlay, type VendoOverlayProps } from "./vendo-overlay.js";
export { defaultVendoGreeting, hasSeen, markSeen, type VendoDiscoverability, type VendoGreeting } from "./discoverability.js";
export { openVendoConversation, type OpenConversationOptions } from "./overlay-registry.js";
export { Remixable, type RemixableProps } from "./remixable.js";
export { playPinCeremony, usePinAction, usePinNudge, type PinCeremonyOptions } from "./pin-ceremony.js";
// The "Add to…" destination picker and the destinations it reads — public
// because the in-thread card (an eject template) is built out of them.
export { AddToPicker, useKnownSlots } from "./add-to-picker.js";
export { VendoTrigger, type VendoTriggerProps } from "./vendo-trigger.js";
export { VendoPalette, type VendoCommand } from "./vendo-palette.js";
export { type HotkeyChord, type PaletteHotkey } from "./palette-hotkey.js";
export { VendoSlot } from "./vendo-slot.js";
export { VendoThread, type VendoThreadProps } from "./thread/index.js";
export { VendoToasts, vendoToast, dismissAllVendoToasts, type VendoToastsProps, type VendoToastInput, type VendoToastAction } from "./vendo-toasts.js";
export { WaitingQueue, type WaitingQueueProps } from "./waiting-queue.js";

/** The eject surface: internals the ejected thread compiles against
    (scripts/eject-templates-lib.mjs enforces this list at build). Exported
    deliberately — ejected chrome keeps data/wire logic as a package
    dependency and only forks pixels (§4 customization ladder). */
export { ActivityLedger } from "./activity-ledger.js";
export {
  describeActivity,
  eventOutcomeLabel,
  formatAuditTime,
  formatRelativeAuditTime,
  kindGlyph,
  outcomeLabel,
  type ActivityGlyph,
  type OutcomeTone,
} from "./activity-semantics.js";
export { BeatSummary, BuildBeat, WorkingBeat, toolPresentation } from "./build-beat.js";
export { ChromeRoot } from "./chrome-root.js";
export { useCopyFeedback } from "./clipboard.js";
export { ConnectDockButton, ConnectTray } from "./connect-dock.js";
export { FluidThinking } from "./fluid-thinking.js";
export {
  useSplitView,
  SplitViewContext,
  type SplitViewContextValue,
} from "./split-view.js";
export { previewArgs, toolkitDisplayName, toolTitle } from "./humanize.js";
export { Markdown } from "./markdown.js";
export { ACTIVITY_ANCHOR_ATTRIBUTE, ACTIVITY_BUMP_EVENT, MorphToast, type MorphToastProps } from "./morph-toast.js";
export { PrefillScopeContext, registerPrefillConsumer } from "./overlay-registry.js";
export { LONG_TEXT_CAP, truncateHead } from "./truncate.js";
