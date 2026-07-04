/**
 * useTrustData — the Trust screen's data plane (ENG-193 §3 Moment 12/§4.3/
 * §6.2). Mirrors `useParkedActions`' seam pattern exactly: polls while
 * mounted, absent `trust` seam -> empty/no-op, the host wires real fetchers
 * (see @flowlet/next's catch-all and the accounting demo's trust-handler.ts).
 * The diary (§3 Moment 10) is summarized CLIENT-SIDE from the last 7 days of
 * audit rows — no server-side diary concept exists; `automation_firing` is
 * counted at FIRING granularity (one per run), not per tool call inside a
 * run (see this plan's Task 6 / deviation #5).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "./context";
import { useParkedActions } from "./use-parked-actions";
import type { TrustAuditRow, TrustGrantRow } from "./context";

const POLL_MS = 30_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DiaryData {
  total: number;
  reads: number;
  approved: number;
  automationRuns: number;
  moneyMoves: number;
}

function summarize(rows: TrustAuditRow[]): DiaryData {
  let reads = 0, approved = 0, automationRuns = 0, moneyMoves = 0;
  for (const row of rows) {
    if (row.kind === "tool_execution") {
      if (row.mutating === false) reads += 1;
      else if (row.dangerous === true) moneyMoves += 1;
      else approved += 1;
    } else if (row.kind === "automation_firing") {
      automationRuns += 1;
    }
  }
  // Money moves fold into the total too (review nit): a week of ONLY money
  // moves must never read "handled 0 things" just because they're broken out
  // as their own counter.
  return { total: reads + approved + automationRuns + moneyMoves, reads, approved, automationRuns, moneyMoves };
}

export function useTrustData() {
  const { trust } = useShell();
  const parked = useParkedActions();
  const [grants, setGrants] = useState<TrustGrantRow[]>([]);
  const [criticalTools, setCriticalTools] = useState<{ name: string }[]>([]);
  const [activity, setActivity] = useState<TrustAuditRow[]>([]);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    if (!trust) return;
    void trust.listGrants().then((rows) => { if (mounted.current) setGrants(rows); });
    void trust.listCriticalTools().then((rows) => { if (mounted.current) setCriticalTools(rows); });
    void trust.queryAudit({ sinceMs: Date.now() - WEEK_MS }).then((rows) => { if (mounted.current) setActivity(rows); });
  }, [trust]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    if (!trust) return undefined;
    const id = setInterval(refresh, POLL_MS);
    return () => { mounted.current = false; clearInterval(id); };
  }, [refresh, trust]);

  const revoke = (id: string) => (trust ? trust.revokeGrant(id).then(refresh) : Promise.resolve());

  return {
    grants: grants.filter((g) => g.source !== "automation"),
    automationGrants: grants.filter((g) => g.source === "automation"),
    criticalTools,
    activity,
    diary: summarize(activity),
    parked,
    revoke,
    refresh,
  };
}
