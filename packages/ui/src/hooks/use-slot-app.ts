/** Slot self-discovery (08-ui §4) — "which app is in slot X, and where is its
 *  build?", so hosts never hand-roll the poll-and-scan dance.
 *
 *  Placement is a ROW now (2026-08-05), not `doc.placements`: the answer
 *  carries a build that has not landed yet (`building`) and one that never
 *  will (`failed`), which a document-scan could not — a build has no document
 *  until it finishes. Every mounted slot shares ONE poller (use-placements),
 *  so a page of slots is one request per tick. */
import type { AppId } from "@vendoai/core";
import { usePlacements } from "./use-placements.js";

export function useSlotApp(slotId: string, options: {
  /** Pass `false` to stand the discovery down entirely (no fetch, no poll) —
   *  used by VendoSlot when the host supplies an explicit `appId`/`pin`. */
  enabled?: boolean;
} = {}): {
  /** The app placed in this slot, whatever state its build is in. */
  appId: AppId | undefined;
  /** Where that app's build stands, or undefined when the slot is empty. */
  status: "ready" | "building" | "failed" | undefined;
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
} {
  const { entry, error, isLoading, refresh } = usePlacements(slotId, options.enabled ?? true);
  return {
    appId: entry?.app,
    status: entry?.status,
    error,
    isLoading,
    refresh,
  };
}
