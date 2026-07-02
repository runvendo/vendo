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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
    if (outcome.status !== "fulfilled") {
      errors.push({ query, error: outcome.reason });
    } else if (query.path === "" && !isPlainObject(outcome.value)) {
      // A root patch replaces the whole data model, which must stay a plain
      // object — a non-object result would corrupt the payload (and any
      // write-back). Keep the snapshot for this query instead.
      errors.push({ query, error: new Error("root query result must be a plain object") });
    } else {
      data = applyPointerPatch(data, query.path, outcome.value);
    }
  });

  const status: RefreshStatus =
    errors.length === 0 ? "live" : errors.length === queries.length ? "snapshot" : "partial";
  const next: UINode = status === "snapshot" ? node : { ...node, payload: { ...payload, data } };
  return { node: next, status, errors };
}

/** Consecutive full-failure ticks after which live refresh gives up. */
const MAX_REFRESH_FAILURES = 3;

/**
 * Reopen a saved flowlet: snapshot immediately, then live re-run through the
 * host's RunQuery seam (when provided). While the view stays open it keeps
 * itself fresh: the (reads-only) queries re-run every `refreshIntervalMs` —
 * only while the tab is visible, stopping after repeated failures. Data-equal
 * ticks are dropped so the stage isn't churned and `updatedAt` doesn't creep.
 * Fresh data is written back onto the CURRENT stored record (a rename/pin
 * during a refresh survives; a deleted record is never resurrected).
 */
export function useReopenFlowlet(flowlet: Flowlet): RefreshResult & { refreshing: boolean } {
  const { store, runQuery, refreshIntervalMs } = useShell();
  const [result, setResult] = useState<RefreshResult>({ node: flowlet.node, status: "snapshot", errors: [] });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    setResult({ node: flowlet.node, status: "snapshot", errors: [] });
    if (!runQuery || flowletQueries(flowlet.node).length === 0) {
      // A prior in-flight refresh may have been cancelled with `refreshing`
      // still true; this open has nothing to refresh, so reset it.
      setRefreshing(false);
      return;
    }

    const dataKey = (node: UINode): string =>
      isGeneratedNode(node) ? JSON.stringify((node.payload as GeneratedPayload).data ?? {}) : "";
    let lastKey = dataKey(flowlet.node);

    const writeBack = async (node: UINode) => {
      try {
        const current = await store.load(flowlet.id);
        if (current) {
          const { updatedAt: _prior, ...base } = current;
          await store.save({ ...base, node });
        }
      } catch (error) {
        console.warn("[flowlet] refreshed-data write-back failed", error);
      }
    };

    const runOnce = async (initial: boolean) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const fresh = await refreshFlowletNode(flowlet.node, runQuery);
        if (cancelled) return;

        if (fresh.status === "snapshot" && fresh.errors.length > 0) {
          failures += 1;
          if (failures >= MAX_REFRESH_FAILURES && timer !== undefined) clearInterval(timer);
          setResult(fresh); // surface the stale state + errors
          return;
        }

        failures = 0;
        const key = dataKey(fresh.node);
        const dataChanged = key !== lastKey;
        // Steady-state ticks with identical data are dropped entirely.
        if (initial || dataChanged || fresh.status !== "live") {
          lastKey = key;
          setResult(fresh);
          if (fresh.status === "live" && (initial || dataChanged)) await writeBack(fresh.node);
        }
      } finally {
        inFlight = false;
      }
    };

    setRefreshing(true);
    void runOnce(true).finally(() => {
      if (!cancelled) setRefreshing(false);
    });

    if (refreshIntervalMs > 0) {
      timer = setInterval(() => {
        // "Pause when hidden": ticks no-op while the document isn't visible.
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        void runOnce(false);
      }, refreshIntervalMs);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
    // Re-run only when a different saved flowlet is opened (or the seams change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowlet.id, runQuery, store, refreshIntervalMs]);

  return { ...result, refreshing };
}
