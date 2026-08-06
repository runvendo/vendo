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
import { useCallback } from "react";
import { useVendoProvider } from "../context.js";
import { useRefreshOnPin } from "./use-pin-refresh.js";
import { type PollOptions, useResource } from "./use-resource.js";

const DEFAULT_POLL_MS = 5000;

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
  const { client } = useVendoProvider();
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
  useRefreshOnPin(refresh, enabled);
  // Latest placement wins ("the newest remix takes the slot"), and the wire
  // lists apps NEWEST FIRST — `runtime.list()` sorts createdAt descending, and
  // an AppDocument carries no timestamp, so list order is the only newness
  // signal here. This read was `.at(-1)`, which is the OLDEST placed app: the
  // exact opposite of its own comment. Two things hid it — the reference host
  // strips the slot off every other app the subject owns, so only one ever
  // carries a placement, and the test mocked `apps.list` with a hand-ordered
  // array instead of the wire's real order.
  const appId = data.find(app => app.placements?.includes(slotId))?.id;
  return { appId, error, isLoading, refresh };
}
