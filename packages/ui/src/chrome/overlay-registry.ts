/** The conversation-opening registry (ui-usage-dx §2/§4).
 *
 * A mounted VendoOverlay registers an opener; any affordance that wants to
 * open the chat preloaded with a prompt (a Trigger button, a slot's empty-state
 * CTA, the ✦ remix popover) calls `openVendoConversation` without needing a ref
 * to the overlay. LIFO: the most recently mounted overlay owns the call.
 *
 * Prompt hand-off is race-free and overlay-scoped by design: each overlay
 * provides a scope through PrefillScopeContext, its thread's composer
 * registers a consumer under that scope, and a delivered prompt goes to the
 * opened overlay's own composer — parking in a pending slot when that
 * composer is still mounting (first open, or the newConversation remount) —
 * never to whichever composer happened to register last, and with no
 * setTimeout choreography (the hand-rolled `vendo:remix` → 260ms →
 * `vendo:prefill` dance this replaces).
 */
import { createContext } from "react";

export interface OpenConversationOptions {
  /** Text to preload into the conversation's composer. */
  prompt?: string;
  /**
   * Grounding the AGENT needs and the person does not — the app id behind a
   * remix, the slot a view lives in. It rides the message the composer sends
   * (so the model reads it) and appears nowhere a person looks: not the
   * textarea, not the transcript bubble, not "edit last message".
   *
   * spec §16 law 3, LEAK 4's follow-up: the remix prefill used to read
   * "Update my <slot> remix (app app_…): " — an id typed at a person — and
   * removing it took the agent's grounding with it. This is the other half.
   */
  context?: string;
  /** Open the overlay SCOPED to one app: it is featured on the workspace stage,
   *  so the view being talked about is the view on screen. The pinned app's ✦
   *  "Edit in chat" is the caller; a docked overlay has no stage and ignores
   *  it. */
  appId?: string;
  /** Send the prompt immediately (default: leave it in the composer). */
  send?: boolean;
  /** Start a fresh conversation instead of resuming the current one. */
  newConversation?: boolean;
  /** Close the overlay when it is already open instead of no-opping — what a
   *  keyboard shortcut wants (a chord toggles, everything else opens). */
  toggle?: boolean;
  /** Close the overlay (a no-op when it is closed) without opening anything —
   *  for a host command menu, so its own navigation never lands behind the
   *  open modal. */
  close?: boolean;
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
export function openVendoConversation(options?: OpenConversationOptions): boolean {
  const top = openers[openers.length - 1];
  if (!top) return false;
  top(options);
  return true;
}

interface Prefill {
  prompt: string;
  send: boolean;
  /** {@link OpenConversationOptions.context} — never rendered. */
  context?: string;
}

/** Stamped by VendoOverlay around its thread so the composer registers its
 * prefill consumer under that overlay's scope. Null outside an overlay
 * (embedded threads/pages) — those never receive overlay-directed prompts. */
export const PrefillScopeContext = createContext<symbol | null>(null);

interface PrefillConsumer {
  consume(prefill: Prefill): void;
  scope: symbol | null;
}

const prefillConsumers: PrefillConsumer[] = [];
let pendingPrefill: { prefill: Prefill; scope: symbol | null } | null = null;

/** A composer subscribes on mount. A prompt parked for its scope (or for any
 * consumer, when scope-less) lands immediately. */
export function registerPrefillConsumer(
  consume: (prefill: Prefill) => void,
  scope: symbol | null = null,
): () => void {
  const consumer: PrefillConsumer = { consume, scope };
  prefillConsumers.push(consumer);
  if (pendingPrefill !== null && (pendingPrefill.scope === null || pendingPrefill.scope === scope)) {
    const parked = pendingPrefill;
    pendingPrefill = null;
    consume(parked.prefill);
  }
  return () => {
    const index = prefillConsumers.lastIndexOf(consumer);
    if (index >= 0) prefillConsumers.splice(index, 1);
  };
}

/** Hand a prompt to the target composer, or park it for the one about to
 * mount. `scope` restricts delivery to one overlay's composer; `defer` skips
 * live delivery entirely — the newConversation path, where the currently
 * mounted composer is about to be replaced and must not drain the prompt. */
export function deliverPrefill(
  prefill: Prefill,
  options: { scope?: symbol | null; defer?: boolean } = {},
): void {
  const scope = options.scope ?? null;
  if (options.defer !== true) {
    const target = scope === null
      ? prefillConsumers[prefillConsumers.length - 1]
      : [...prefillConsumers].reverse().find(consumer => consumer.scope === scope);
    if (target) {
      target.consume(prefill);
      return;
    }
  }
  pendingPrefill = { prefill, scope };
}
