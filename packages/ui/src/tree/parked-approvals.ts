/**
 * What happens to a press the guard parked.
 *
 * `pending-approval` is the honest answer at press time — nothing has changed
 * yet — so the node paints "waiting for approval" and the screen stops there.
 * Nothing ever cleared it. The decision lands on a different surface entirely
 * (the approvals queue, another tab, the host's own card), the server resumes
 * the exact parked call from `guard.onApprovalDecision`, and the screen that
 * pressed the button was never told: it sat on "Sending…" forever, over data
 * the backend had already changed.
 *
 * This watches every outstanding parked press for its terminal state. The
 * same-tab `vendo:approvals-decided` announcement settles it the moment the
 * decision lands; a slow poll covers every decision this page cannot hear.
 */
import { useEffect, useRef } from "react";
import { APPROVALS_DECIDED_EVENT, type ApprovalsDecidedDetail } from "../client-impl.js";
import { useVendoClientOrNone } from "../context.js";
import type { ApprovalResolution } from "../wire-types.js";

/** Slower than the approvals feed on purpose: this is the backstop for a
 *  decision made where the page cannot hear it, not the primary signal. */
const POLL_MS = 5_000;

const hidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * @param parked nodeId → the approval its press is waiting on.
 * @param onResolved fires once per node with the approval's terminal state.
 */
export function useParkedApprovals(
  parked: ReadonlyMap<string, string>,
  onResolved: (nodeId: string, resolution: ApprovalResolution) => void,
): void {
  const client = useVendoClientOrNone();
  // Read at fire time, always from the newest render — so the effect below
  // re-arms only when the SET of outstanding approvals changes.
  const latest = useRef({ parked, onResolved });
  latest.current = { parked, onResolved };
  const outstanding = [...parked].map(([nodeId, approvalId]) => `${nodeId}=${approvalId}`).join(",");

  useEffect(() => {
    if (client === undefined || outstanding === "") return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = async (only?: ReadonlySet<string>): Promise<void> => {
      for (const [nodeId, approvalId] of latest.current.parked) {
        if (only !== undefined && !only.has(approvalId)) continue;
        // A failed read is TRANSIENT, never a verdict: the server runs the
        // resumed call INSIDE the decision, so a read landing in that window
        // finds neither a pending ask nor an outcome yet. The next pass asks
        // again and the pending notice stands meanwhile — today's behavior.
        const resolution = await client.approvals.get(approvalId).catch(() => undefined);
        if (!live) return;
        if (resolution !== undefined && resolution.state !== "pending") {
          latest.current.onResolved(nodeId, resolution);
        }
      }
    };
    const poll = async (): Promise<void> => {
      // A background tab asks nothing (the approvals feed's rule); the first
      // tick after the person comes back picks the answer up.
      if (!hidden()) await settle();
      if (live) timer = setTimeout(() => void poll(), POLL_MS);
    };
    const onDecided = (event: Event): void => {
      const detail = (event as CustomEvent<ApprovalsDecidedDetail>).detail;
      if (detail === undefined || !Array.isArray(detail.ids)) return;
      void settle(new Set(detail.ids));
    };
    window.addEventListener(APPROVALS_DECIDED_EVENT, onDecided);
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener(APPROVALS_DECIDED_EVENT, onDecided);
    };
  }, [client, outstanding]);
}
