/** @vendoai/ui/chrome — the shipped, theme-adopting surfaces (08-ui §4). */
export { ActivityPanel } from "./activity-panel.js";
export { VendoActivities, type VendoActivitiesProps } from "./vendo-activities.js";
export { ApprovalCard, type ApprovalCardProps } from "./approval-card.js";
export { AutomationsPanel } from "./automations-panel.js";
export { ConnectCard, type ConnectCardProps } from "./connect-card.js";
export { ConnectedAccountsPanel } from "./connected-accounts-panel.js";
export { NoPolicyNotice } from "./no-policy-notice.js";
export { VendoOverlay, type VendoOverlayProps } from "./vendo-overlay.js";
export { openVendoConversation, type OpenConversationOptions } from "./overlay-registry.js";
export { VendoPage } from "./vendo-page.js";
export { VendoPalette, type VendoCommand } from "./vendo-palette.js";
export { type HotkeyChord, type PaletteHotkey } from "./palette-hotkey.js";
export { VendoSlot } from "./vendo-slot.js";
export { VendoThread } from "./thread/index.js";
export { VendoToasts, vendoToast, dismissAllVendoToasts, type VendoToastsProps, type VendoToastInput, type VendoToastAction } from "./vendo-toasts.js";
export { WaitingQueue, type WaitingQueueProps } from "./waiting-queue.js";
export { VendoStage } from "../voice/stage.js";
