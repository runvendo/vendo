/** Pending approval transport (08-ui §3). */
import type { ApprovalDecision, ApprovalId, ApprovalRequest } from "@vendoai/core";
import { useCallback, useEffect, useState } from "react";
import { useVendoContext } from "../context.js";

export function useApprovals(): {
  pending: ApprovalRequest[];
  decide(ids: ApprovalId | ApprovalId[], decision: ApprovalDecision): Promise<void>;
} {
  const { client } = useVendoContext();
  const [pending, setPending] = useState<ApprovalRequest[]>([]);

  const refresh = useCallback(async () => setPending(await client.approvals.pending()), [client]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const decide = useCallback(
    async (ids: ApprovalId | ApprovalId[], decision: ApprovalDecision) => {
      await client.approvals.decide(ids, decision);
      await refresh();
    },
    [client, refresh],
  );

  return { pending, decide };
}
