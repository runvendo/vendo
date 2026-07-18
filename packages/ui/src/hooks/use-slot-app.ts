/** Slot pin self-discovery (08-ui §4) — resolve "the app currently pinned to
 *  slot X" so hosts never hand-roll the poll-apps-and-filter dance. Rides the
 *  standard useResource lifecycle (SSR-safe: fetching starts in an effect),
 *  polling by default so a pin made in the conversation surface appears in the
 *  slot on its own. */
import type { AppDocument, AppId } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";

const DEFAULT_POLL_MS = 5000;

const NO_APPS: AppDocument[] = [];

export function useSlotApp(slotId: string, options: PollOptions & {
  /** Pass `false` to stand the discovery down entirely (no fetch, no poll) —
   *  used by VendoSlot when the host supplies an explicit `appId`/`pin`. */
  enabled?: boolean;
} = {}): {
  /** The most recently pinned app for this slot, or undefined when none. */
  appId: AppId | undefined;
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
} {
  const { client } = useVendoContext();
  const enabled = options.enabled ?? true;
  const list = useCallback(
    () => (enabled ? client.apps.list() : Promise.resolve(NO_APPS)),
    [client, enabled],
  );
  const { data, error, isLoading, refresh } = useResource(list, NO_APPS, {
    pollMs: enabled ? options.pollMs ?? DEFAULT_POLL_MS : 0,
  });
  // Latest pin wins — matching the "the newest remix takes the slot" semantics
  // the demos established (hero-slot took `.at(-1)`).
  const appId = data.filter(app => app.pins?.some(pin => pin.slot === slotId)).at(-1)?.id;
  return { appId, error, isLoading, refresh };
}
