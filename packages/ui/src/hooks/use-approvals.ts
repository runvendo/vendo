/** Pending approval transport (08-ui §3). */
import type { ApprovalDecision, ApprovalId, ApprovalRequest } from "@vendoai/core";
import { useCallback, useSyncExternalStore } from "react";
import { useVendoContext } from "../context.js";
import {
  markRunResultsSeen,
  subscribeRunActivity,
  unseenRunResult,
  type RunResult,
} from "../chrome/run-activity.js";
import { APPROVALS_LOADING, approvalsFeed } from "./approvals-feed.js";
import { type PollOptions } from "./use-resource.js";

/** SSR / first-render snapshot, stable across calls. */
const loadingSnapshot = () => APPROVALS_LOADING;

export function useApprovals(options?: PollOptions): {
  pending: ApprovalRequest[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  decide(ids: ApprovalId | ApprovalId[], decision: ApprovalDecision, decideOptions?: { grantSetId?: string }): Promise<void>;
} {
  const { client } = useVendoContext();
  // H15 — every surface shares ONE poller per client (approvals-feed), so the
  // launcher badge, the waiting strip, the rail and the toast feed cost one
  // request between them instead of one each.
  const feed = approvalsFeed(client);
  const pollMs = options?.pollMs ?? 0;
  const subscribe = useCallback((listener: () => void) => feed.subscribe(listener, pollMs), [feed, pollMs]);
  const { data, error, isLoading } = useSyncExternalStore(subscribe, feed.read, loadingSnapshot);
  const refresh = useCallback(() => feed.refresh(), [feed]);

  const decide = useCallback(
    async (ids: ApprovalId | ApprovalId[], decision: ApprovalDecision, decideOptions?: { grantSetId?: string }) => {
      await client.approvals.decide(ids, decision, decideOptions);
      await refresh();
    },
    [client, refresh],
  );

  return { pending: data, error, isLoading, refresh, decide };
}

const NO_RESULT = (): RunResult | undefined => undefined;

/**
 * LANE D §4 (N1) — the ONE attention source. Everything that asks for the
 * user's attention counts from here: the launcher's numbered badge, the
 * "Waiting on you · N" strip above the composer, and the quiet dot for a run
 * that finished while they were elsewhere. Two surfaces reading two counts
 * could disagree in front of the user; this is the same hook, so they can't.
 *
 * Everything `useApprovals` returns (rows, `decide`, `refresh`) comes through
 * unchanged, so a surface that shows the count AND the cards needs one hook.
 */
export function useAttention(options?: PollOptions): ReturnType<typeof useApprovals> & {
  /** Asks waiting on the user right now (the badge number, the strip count). */
  askCount: number;
  /** Alias for the rows behind that count, in the strip's own words. */
  asks: ApprovalRequest[];
  /** A finished run whose result nobody has looked at yet (the quiet dot). */
  unseenResults: boolean;
  /** The finished run itself — headline + the thread to deep-link into. */
  lastResult: RunResult | undefined;
  /** The user looked: clears the dot (and any completion toast). */
  markResultsSeen(): void;
} {
  const approvals = useApprovals(options);
  const lastResult = useSyncExternalStore(subscribeRunActivity, unseenRunResult, NO_RESULT);
  return {
    ...approvals,
    askCount: approvals.pending.length,
    asks: approvals.pending,
    unseenResults: lastResult !== undefined,
    lastResult,
    markResultsSeen: markRunResultsSeen,
  };
}
