/** The slot registry, read (08-ui §3) — every destination a mounted
 * `VendoSlot` has reported, newest first. The "Add to…" picker's only source
 * of places to put a generated view. */
import { useCallback } from "react";
import { useVendoProvider } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";
import type { SlotEntry } from "../wire-types.js";

export function useSlots(options?: PollOptions): {
  slots: SlotEntry[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
} {
  const { client } = useVendoProvider();
  const list = useCallback(() => client.slots.list(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as SlotEntry[], options);
  return { slots: data, error, isLoading, refresh };
}
