/** The overlay-opening registry — `openVendoPalette`'s pattern generalized to
 * the conversation surface (ui-usage-dx §2/§4).
 *
 * A mounted VendoOverlay registers an opener; any affordance that wants to
 * open the chat preloaded with a prompt (the Slot remix flag, a Trigger
 * button, palette default commands) calls `openVendoOverlay` without needing a
 * ref to the overlay. LIFO like the palette registries: the most recently
 * mounted overlay owns the call.
 *
 * Prompt hand-off is race-free by design: the composer registers a consumer on
 * mount, so a prompt delivered while the overlay's thread is still mounting
 * parks in a pending slot and lands the moment the composer appears — no
 * setTimeout choreography (the hand-rolled `vendo:remix` → 260ms →
 * `vendo:prefill` dance this replaces).
 */

export interface OpenConversationOptions {
  /** Text to preload into the conversation's composer. */
  prompt?: string;
  /** Send the prompt immediately (default: leave it in the composer). */
  send?: boolean;
}

type OverlayOpener = (options?: OpenConversationOptions) => void;
const openers: OverlayOpener[] = [];

/** Register a mounted overlay's opener; returns an unsubscribe. */
export function registerOverlayOpener(open: OverlayOpener): () => void {
  openers.push(open);
  return () => {
    const index = openers.lastIndexOf(open);
    if (index >= 0) openers.splice(index, 1);
  };
}

/** Open the most-recently-mounted overlay, optionally preloading a prompt.
 * Returns `false` when no overlay is mounted so callers can fall back. */
export function openVendoOverlay(options?: OpenConversationOptions): boolean {
  const top = openers[openers.length - 1];
  if (!top) return false;
  top(options);
  return true;
}

interface Prefill {
  prompt: string;
  send: boolean;
}

const prefillConsumers: ((prefill: Prefill) => void)[] = [];
let pendingPrefill: Prefill | null = null;

/** A composer subscribes on mount. If a prompt was delivered before any
 * composer existed (the overlay's first open), it lands here immediately. */
export function registerPrefillConsumer(consume: (prefill: Prefill) => void): () => void {
  prefillConsumers.push(consume);
  if (pendingPrefill !== null) {
    const parked = pendingPrefill;
    pendingPrefill = null;
    consume(parked);
  }
  return () => {
    const index = prefillConsumers.lastIndexOf(consume);
    if (index >= 0) prefillConsumers.splice(index, 1);
  };
}

/** Hand a prompt to the most-recently-mounted composer, or park it for the
 * one about to mount. */
export function deliverPrefill(prefill: Prefill): void {
  const top = prefillConsumers[prefillConsumers.length - 1];
  if (top) top(prefill);
  else pendingPrefill = prefill;
}
