import { useEffect, useState } from "react";
import {
  applyPointerPatch,
  isGeneratedNode,
  type DataQuery,
  type GeneratedPayload,
  type UINode,
} from "@flowlet/core";
import type { Flowlet } from "./seams/store";
import type { RunQuery } from "./seams/query";
import { useShell } from "./context";

export type RefreshStatus = "live" | "partial" | "snapshot";

export interface RefreshResult {
  node: UINode;
  status: RefreshStatus;
  errors: { query: DataQuery; error: unknown }[];
}

/** The declared queries of a saved node ([] when none / not generated). */
export function flowletQueries(node: UINode): DataQuery[] {
  if (!isGeneratedNode(node)) return [];
  return (node.payload as GeneratedPayload).queries ?? [];
}

/**
 * Re-run a saved view's declared queries and patch fresh results into its data
 * model. Per-query failures keep the snapshot for that path (graceful fallback);
 * the tree itself never changes, so the stage re-renders via data deltas.
 */
export async function refreshFlowletNode(node: UINode, runQuery: RunQuery): Promise<RefreshResult> {
  if (!isGeneratedNode(node)) return { node, status: "snapshot", errors: [] };
  const payload = node.payload as GeneratedPayload;
  const queries = payload.queries ?? [];
  if (queries.length === 0) return { node, status: "snapshot", errors: [] };
  const settled = await Promise.allSettled(queries.map((query) => runQuery(query)));

  let data = (payload.data ?? {}) as Record<string, unknown>;
  const errors: RefreshResult["errors"] = [];
  settled.forEach((outcome, i) => {
    const query = queries[i]!;
    if (outcome.status === "fulfilled") data = applyPointerPatch(data, query.path, outcome.value);
    else errors.push({ query, error: outcome.reason });
  });

  const status: RefreshStatus =
    errors.length === 0 ? "live" : errors.length === queries.length ? "snapshot" : "partial";
  const next: UINode = status === "snapshot" ? node : { ...node, payload: { ...payload, data } };
  return { node: next, status, errors };
}

/**
 * Reopen a saved flowlet: snapshot immediately, then live re-run through the
 * host's RunQuery seam (when provided). A fully-live refresh is written back to
 * the store so the next snapshot is newer; write-back failures only warn.
 */
export function useReopenFlowlet(flowlet: Flowlet): RefreshResult & { refreshing: boolean } {
  const { store, runQuery } = useShell();
  const [result, setResult] = useState<RefreshResult>({ node: flowlet.node, status: "snapshot", errors: [] });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult({ node: flowlet.node, status: "snapshot", errors: [] });
    if (!runQuery || flowletQueries(flowlet.node).length === 0) return;

    setRefreshing(true);
    void refreshFlowletNode(flowlet.node, runQuery)
      .then(async (fresh) => {
        if (cancelled) return;
        setResult(fresh);
        if (fresh.status === "live") {
          const { updatedAt: _prior, ...draft } = flowlet;
          await store.save({ ...draft, node: fresh.node }).catch((error: unknown) => {
            console.warn("[flowlet] refreshed-data write-back failed", error);
          });
        }
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => { cancelled = true; };
    // Re-run only when a different saved flowlet is opened (or the seams change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowlet.id, runQuery, store]);

  return { ...result, refreshing };
}
