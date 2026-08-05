/** "Re-read because a pin just landed", in one place.
 *
 *  A pin is a HOST write (`onPin`), so nothing in this package can see it
 *  happen — a surface showing pinned apps would sit stale until its next poll
 *  tick, or forever if it does not poll. The pin bus announces instead.
 *
 *  The second read is the load-bearing half: `onPin` is fire-and-forget by
 *  contract (it returns void), so the read on the announcement itself can beat
 *  the host's write to the server. The settle read lands as the ceremony's ghost
 *  does (~480ms), which is also the moment the user is looking at the
 *  destination. Any poll the caller has stays the floor under both.
 *
 *  Both callers — slot discovery and the Apps shelf — are destinations the pin
 *  ceremony flies into, which is why they cannot be left to a poll: the flight
 *  would land in a surface that does not have the app yet. */
import { useEffect } from "react";
import { onPinAnnounced } from "../pin-events.js";

const PIN_SETTLE_MS = 500;

export function useRefreshOnPin(refresh: () => Promise<void>, enabled = true): void {
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
}
