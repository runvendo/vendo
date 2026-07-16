"use client";

import { useApprovals } from "@vendoai/ui";
import { ApprovalCard } from "@vendoai/ui/chrome";

/** ENG-286: Maple's in-product approvals inbox. Agent actions that park for
 * consent — including calls arriving through the MCP door — surface here as
 * the standard ApprovalCard, so "resolve it in-product" has a visible place
 * in Maple's own UI. Renders nothing while the queue is empty. */
export function MapleApprovals() {
  const { pending, decide } = useApprovals();
  if (pending.length === 0) return null;
  return (
    <section aria-label="Pending Vendo approvals" className="space-y-3 pb-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink">Needs your approval</h2>
        <p className="text-sm text-muted">
          An agent asked to act on your account. Review the exact request before it runs.
        </p>
      </div>
      {pending.map((approval) => (
        <div key={approval.id} className="maple-approval-inflow">
          <ApprovalCard approval={approval} onDecide={(decision) => decide(approval.id, decision)} />
        </div>
      ))}
    </section>
  );
}
