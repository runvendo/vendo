/**
 * Notifications seam (FlowletToasts, 2026-07-04 spec): the client-side view of
 * the runtime's in-app Channels deliveries. The real client (@flowlet/next's
 * FlowletRoot) polls the handler's /deliveries route and posts approvals to
 * /resume; the local default is an inert seed for tests and storybook-style
 * hosts.
 */

/** One automation delivery, flattened for the shell. */
export interface AutomationNotice {
  /** Monotonic per-feed cursor; the client persists the last one it has seen. */
  cursor: number;
  kind: "completed" | "approval-required";
  runId: string;
  /** The paused step awaiting approval; only on `approval-required`. */
  stepId?: string;
  /** Human one-liner for the toast body. */
  summary: string;
  /** Full plain-text message (the Channels `text`). */
  text: string;
}

export type ResumeOutcome = "resumed" | "stale";

export interface FlowletNotifications {
  /** All notices with cursor > `since`, oldest first. */
  listSince(since: number): Promise<AutomationNotice[]>;
  /** Approve/deny the paused run behind an approval notice. Pass the notice's
   *  `stepId` so a run that has since paused on a DIFFERENT step answers
   *  `stale` instead of approving something the user never saw. `stale` also
   *  covers expired, cancelled, and already-resumed runs. */
  resume(runId: string, approved: boolean, stepId?: string): Promise<ResumeOutcome>;
}

/** Inert local default: seeded notices, resumes always stale. */
export function createLocalNotifications(seed: AutomationNotice[] = []): FlowletNotifications {
  return {
    async listSince(since) {
      return seed.filter((n) => n.cursor > since);
    },
    async resume() {
      return "stale";
    },
  };
}
