"use client";

/** @vendoai/ui/chrome — the shipped, theme-adopting surfaces (08-ui §4). */
export { ApprovalCard, type ApprovalCardProps } from "./approval-card.js";
export { VendoAppEmbed, VendoApprovalEmbed, VendoToolResult } from "./embeds.js";
export { ApprovalSheet } from "./approval-sheet.js";
export { AutomationCard, sponsorLabel, type AutomationCardProps } from "./automation-card.js";
export { GrantSetCard, grantSetPermissions, type GrantSetCardProps, type GrantSetPermission } from "./grant-set-card.js";
export { ConnectCard, type ConnectCardProps } from "./connect-card.js";
// Build contract §9.4 — the consumer-voice fork offer a viewer sees instead of
// a refusal.
export { ForkOffer, encodeGrantPrincipal, type ForkOfferProps } from "./fork-offer.js";
export { NoPolicyNotice } from "./no-policy-notice.js";
export { VendoOverlay, type VendoOverlayProps } from "./vendo-overlay.js";
export { defaultVendoGreeting, hasSeen, markSeen, type VendoDiscoverability, type VendoGreeting } from "./discoverability.js";
export { openVendoConversation, type OpenConversationOptions } from "./overlay-registry.js";
export { Remixable, type RemixableProps } from "./remixable.js";
export { playPinCeremony, usePinAction, usePinNudge, type PinCeremonyOptions } from "./pin-ceremony.js";
// Placement — `AddToPicker` is the destination menu on its own, for a surface
// that only ever wants the choice. Destinations come from `useSlots` on the
// root surface.
export { AddToPicker } from "./add-to-picker.js";
export { VendoTrigger, type VendoTriggerProps } from "./vendo-trigger.js";
export { VendoPalette, type VendoCommand } from "./vendo-palette.js";
export { type HotkeyChord, type PaletteHotkey } from "./palette-hotkey.js";
export { VendoSlot } from "./vendo-slot.js";
/** Re-exported beside VendoSlot: it is the shape of that component's
    `onParked` prop, and defined with the tree that fires it. */
export type { ParkedPress } from "../tree/renderer.js";
/** A host building its own surface needs this seam to give parked presses an
    ask — `thread/parts.tsx` mounts the same modal per app card. */
export { useApprovalModal, type ParkedApproval } from "./approval-modal.js";
export { VendoThread, type VendoThreadProps } from "./thread/index.js";
export { VendoToasts, vendoToast, dismissAllVendoToasts, type VendoToastsProps, type VendoToastInput, type VendoToastAction } from "./vendo-toasts.js";

/** Chrome internals a host composing its own surface builds against: one tool
    call's transcript beat, and the root that provides the chrome context. */
export { BuildBeat } from "./build-beat.js";
export { ChromeRoot } from "./chrome-root.js";
