/** Pending approval transport (08-ui §3). */
import type { ApprovalDecision, ApprovalId, ApprovalRequest } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";

export function useApprovals(options?: PollOptions): {
  /** Back-compat alias for `data` (contract §3). */
  pending: ApprovalRequest[];
  data: ApprovalRequest[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  decide(ids: ApprovalId | ApprovalId[], decision: ApprovalDecision): Promise<void>;
} {
  const { client } = useVendoContext();
  const list = useCallback(() => client.approvals.pending(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as ApprovalRequest[], options);

  const decide = useCallback(
    async (ids: ApprovalId | ApprovalId[], decision: ApprovalDecision) => {
      await client.approvals.decide(ids, decision);
      await refresh();
    },
    [client, refresh],
  );

  return { pending: data, data, error, isLoading, refresh, decide };
}
