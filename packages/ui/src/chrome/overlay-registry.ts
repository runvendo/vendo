/** The conversation-opening registry — `openVendoPalette`'s pattern
 * generalized to the conversation surface (ui-usage-dx §2/§4).
 *
 * A mounted VendoOverlay registers an opener; any affordance that wants to
 * open the chat preloaded with a prompt (the Slot remix flag, a Trigger
 * button, palette default commands) calls `openVendoConversation` without
 * needing a ref to the overlay. LIFO like the palette registries: the most
 * recently mounted overlay owns the call.
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
  /** Send the prompt immediately (default: leave it in the composer). */
  send?: boolean;
  /** Start a fresh conversation instead of resuming the current one. */
  newConversation?: boolean;
  /** Close the overlay when it is already open instead of no-opping — the
   *  one-surface ⌘K behavior (the keybinding toggles, everything else opens). */
  toggle?: boolean;
  /** Close the overlay (a no-op when it is closed) without opening anything —
   *  used before handing a command to the host router, mirroring the old
   *  palette dialog's close-on-select. */
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

/** One palette command — the shape hosts route in `VendoPalette.onCommand`.
 *  Lives here (not in vendo-palette) because the overlay renders these as its
 *  composer chip strip; the palette re-exports it for compatibility. */
export interface VendoCommand {
  id: string;
  label: string;
  kind: "new-conversation" | "open-app" | "show-activity";
  appId?: string;
}

/** The command set a (headless) VendoPalette publishes for the overlay's chip
 *  strip: the commands plus the palette's own routing (which folds in the host
 *  `onCommand` when supplied). LIFO like every registry here — the most
 *  recently mounted palette owns the strip. */
export interface ConversationCommandSet {
  commands: VendoCommand[];
  select(command: VendoCommand): void;
}

const commandSets: ConversationCommandSet[] = [];
const commandListeners = new Set<() => void>();

/** Publish a command set for the conversation surface; returns an unsubscribe. */
export function registerConversationCommands(set: ConversationCommandSet): () => void {
  commandSets.push(set);
  for (const listener of commandListeners) listener();
  return () => {
    const index = commandSets.lastIndexOf(set);
    if (index >= 0) commandSets.splice(index, 1);
    for (const listener of commandListeners) listener();
  };
}

/** The active (most recently published) command set, or null. Stable reference
 *  between changes so it works as a useSyncExternalStore snapshot. */
export function getConversationCommands(): ConversationCommandSet | null {
  return commandSets[commandSets.length - 1] ?? null;
}

/** Subscribe to command-set changes (useSyncExternalStore-compatible). */
export function subscribeConversationCommands(listener: () => void): () => void {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
}

interface Prefill {
  prompt: string;
  send: boolean;
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
