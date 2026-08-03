/** Slot self-discovery (08-ui §4) — resolve "the app currently placed in
 *  slot X" so hosts never hand-roll the poll-apps-and-filter dance. Rides the
 *  standard useResource lifecycle (SSR-safe: fetching starts in an effect),
 *  polling by default so a placement made in the conversation surface appears
 *  in the slot on its own. Placement is `doc.placements` ONLY (2026-08-02
 *  pins/placements split): `pins` records fork provenance and never mounts an
 *  app in a slot. Legacy rows that stored a placement as a fake-hash pin are
 *  classified into `placements` by the server's read path, so they arrive
 *  here already split. */
import type { AppDocument, AppId } from "@vendoai/core";
import { useCallback, useEffect } from "react";
import { useVendoContext } from "../context.js";
import { onPinAnnounced } from "../pin-events.js";
import { type PollOptions, useResource } from "./use-resource.js";

const DEFAULT_POLL_MS = 5000;

/** A second read as the pin ceremony's ghost lands (~480ms). The host's write
 *  is fire-and-forget when `onPin` returns void, so the read on the pin itself
 *  can beat it to the server; this covers that without waiting for the poll. */
const PIN_SETTLE_MS = 500;

const NO_APPS: AppDocument[] = [];

export function useSlotApp(slotId: string, options: PollOptions & {
  /** Pass `false` to stand the discovery down entirely (no fetch, no poll) —
   *  used by VendoSlot when the host supplies an explicit `appId`/`pin`. */
  enabled?: boolean;
} = {}): {
  /** The most recently placed app for this slot, or undefined when none. */
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
  // A pin is a HOST write, so nothing here can see it — the slot used to sit
  // empty for up to a poll tick after the user asked for the app. The pin
  // announces itself instead; the poll stays as the floor.
  useEffect(() => {
    if (!enabled) return;
    const settles = new Set<ReturnType<typeof setTimeout>>();
    const stop = onPinAnnounced(() => {
      void refresh();
      const settle = setTimeout(() => {
        settles.delete(settle);
        void refresh();
      }, PIN_SETTLE_MS);
      settles.add(settle);
    });
    return () => {
      stop();
      for (const settle of settles) clearTimeout(settle);
    };
  }, [enabled, refresh]);
  // Latest placement wins — matching the "the newest remix takes the slot"
  // semantics the demos established (hero-slot took `.at(-1)`).
  const appId = data.filter(app => app.placements?.includes(slotId)).at(-1)?.id;
  return { appId, error, isLoading, refresh };
}
