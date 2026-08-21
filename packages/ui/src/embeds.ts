import type { VendoAppRef, VendoApprovalRef } from "@vendoai/core";

/**
 * Existing-agents contract — prop shapes for the three embeds a BYO chat
 * surface renders from `vendo_*` tool outputs. The components behind them are
 * built on the existing slot / build-beat / approval-card machinery, on the
 * defaults a `VendoProvider` overrides when the host mounts one.
 * Frozen in `docs/superpowers/specs/2026-07-20-existing-agents-contracts.md`.
 */

/** Inline generated app: build-beat while the build streams, then the live
 *  app. In-app interactions go over the wire, not through the host loop. */
export interface VendoAppEmbedProps {
  refValue: VendoAppRef;
}

/** Where an approval embed can be, in the order it gets there. The wire owns
 *  the state; the embed only renders it — resolving in place to the executed
 *  outcome, "declined", or "expired" (the existing failed/expired vocabulary,
 *  never a silent blank). */
export type VendoApprovalEmbedState = "pending" | "executed" | "declined" | "expired";

/** Approve/deny for a parked guarded call. */
export interface VendoApprovalEmbedProps {
  refValue: VendoApprovalRef;
}

/** The dispatcher: give it any `vendo_*` tool output and it renders the right
 *  embed by `parseVendoToolEnvelope`, or nothing for plain data. */
export interface VendoToolResultProps {
  output: unknown;
}
