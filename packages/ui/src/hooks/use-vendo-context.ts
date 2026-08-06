/** Spec 2026-08-05 §3 — merge structured host data into the [Situation]
 *  channel for every message sent while mounted; removed on unmount. Rides the
 *  same `context` POST field the screen snapshot does, so the agent sees one
 *  merged situation. */
import { useEffect, useRef } from "react";
import { publishSituation, retireSituation } from "../situation.js";

export function useVendoContext(data: Record<string, unknown>): void {
  // Stable identity per hook instance, so several mounted callers coexist.
  const key = useRef(Symbol("vendo-situation")).current;
  useEffect(() => {
    publishSituation(key, data);
    return () => retireSituation(key);
  }, [key, data]);
}
