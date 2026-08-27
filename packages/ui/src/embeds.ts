import { VENDO_TOOL_PREFIX, type VendoAppRef, type VendoApprovalRef } from "@vendoai/core";
import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIDataTypes,
  type UIMessagePart,
  type UITools,
} from "ai";

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

/**
 * Is this message part Vendo's? True for a tool part — `dynamic-tool` and
 * `tool-<name>` alike — whose tool name carries the prefix every pack tool is
 * namespaced under. It narrows, so `part.output` and `part.state` read after it
 * with no cast.
 *
 * ```tsx
 * if (isVendoToolPart(part)) return <VendoToolResult output={part.output} />;
 * // your own parts fall through to your own rendering
 * ```
 *
 * It answers "is this Vendo's", never "is it finished": a part still streaming
 * carries no output and `<VendoToolResult>` renders nothing for it, so
 * `part.state === "output-available"` stays your own visible check, for
 * wherever you want to show a running one.
 *
 * Order it against your own tools however you like — it matches on the tool
 * NAME, so a host's own `dynamic-tool` part is never mistaken for one of ours.
 */
export function isVendoToolPart<TOOLS extends UITools>(
  part: UIMessagePart<UIDataTypes, TOOLS>,
): part is ToolUIPart<TOOLS> | DynamicToolUIPart {
  return isToolUIPart(part) && getToolName(part).startsWith(VENDO_TOOL_PREFIX);
}
