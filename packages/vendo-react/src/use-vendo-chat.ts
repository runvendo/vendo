import { useChat } from "@ai-sdk/react";
import type { VendoUIMessage } from "@vendoai/core";
import { useVendoContext } from "./provider.js";

/**
 * Wraps the ai SDK `useChat` with Vendo's registry and native human-in-the-loop
 * tool approvals. `addToolApprovalResponse({ id, approved })` answers an
 * `approval-requested` tool part; `sendAutomaticallyWhen` auto-resubmits the turn once
 * all approvals are in, which runs the approved tool and renders its `data-ui` node.
 */
export function useVendoChat() {
  const { registry, chat } = useVendoContext();
  // `experimental_throttle` coalesces per-token state updates onto a 50ms cadence
  // so streaming text re-renders smoothly instead of thrashing on every delta.
  const helpers = useChat<VendoUIMessage>({ chat, experimental_throttle: 50 });
  return { ...helpers, registry };
}
