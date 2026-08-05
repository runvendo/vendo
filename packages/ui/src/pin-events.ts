/** The pin bus: "a pin just landed" as a fact any surface can act on.
 *
 *  A pin is a host write (`onPin`), so the slot holding the result has no way
 *  to know it happened — it discovered new pins only on its ≤5s poll tick, and
 *  the user watched an empty slot for up to five seconds after asking for one.
 *  Announcing the pin lets every mounted slot re-read immediately.
 *
 *  Module-scope like the overlay/palette registries (chrome/overlay-registry),
 *  and for the same reason: the announcer (a card in the thread) and the
 *  listener (a slot somewhere in the host's page) share no React tree. */

type PinListener = (appId: string) => void;

const listeners = new Set<PinListener>();
const taken = new Set<string>();

/** Subscribe to pins; returns an unsubscribe. */
export function onPinAnnounced(listener: PinListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Announce that `appId` was just pinned. */
export function announcePin(appId: string): void {
  taken.add(appId);
  for (const listener of [...listeners]) listener(appId);
}

/** Whether this app's pin has already been taken — the same fact the bus
 *  announces, retained so an affordance that mounts LATER (a card re-rendered
 *  from the thread, the stage featuring the app again) is not left inviting a
 *  pin the user already gave. Session-scoped by design: a placement made in an
 *  earlier session lives on the app document, which no pin affordance holds. */
export function pinTaken(appId: string): boolean {
  return taken.has(appId);
}
