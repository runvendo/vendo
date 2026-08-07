import { useEffect, useMemo } from "react";
import { useApps } from "../hooks/use-apps.js";
import { developmentMode } from "./dev-mode.js";
import {
  openVendoConversation,
  registerConversationCommands,
  type VendoCommand,
} from "./overlay-registry.js";
import { isEditableTarget, registerPaletteHotkey, registerPaletteOpener, resolveHotkeyMatcher, type PaletteHotkey } from "./palette-hotkey.js";

// Compatibility re-export: the command shape moved to the overlay registry
// (the overlay renders the commands now), but hosts import it from here.
export type { VendoCommand } from "./overlay-registry.js";

/** 08-ui §4 — the ⌘K entry point, one-surface edition (ui-lane-entry pick P-C).
 *
 * The palette no longer renders a dialog of its own: ⌘K opens the SAME
 * conversation overlay the launcher opens (toggling it closed on a second
 * press), and the palette's commands render as the overlay's chip strip above
 * the composer. Typed text that matches no command was never anything but a
 * question — now it simply IS the message, so the "No matching commands" dead
 * end no longer exists.
 *
 * What remains here is everything that made VendoPalette safe to drop into a
 * host, unchanged in behavior:
 * - the host-collision-safe singleton keybinding (ENG-222): one shared
 *   document listener no matter how many palettes mount, a configurable /
 *   disable-able `hotkey` chord, and no keystroke stolen from a focused host
 *   input;
 * - the programmatic opener seam (ENG-223): `openVendoPalette()` still works
 *   and now opens the conversation surface;
 * - command routing: a host `onCommand` receives every chip activation;
 *   without one, conversation commands self-route through the overlay
 *   registry and the rest hint in dev instead of dying silently.
 */
export function VendoPalette({ onCommand, hotkey }: { onCommand?(command: VendoCommand): void; hotkey?: PaletteHotkey }) {
  const { apps } = useApps();
  const commands = useMemo<VendoCommand[]>(() => [
    { id: "new-conversation", label: "New conversation", kind: "new-conversation" },
    ...apps.map(app => ({ id: `open-${app.id}`, label: `Open ${app.name}`, kind: "open-app" as const, appId: app.id })),
    { id: "show-activity", label: "Show activity", kind: "show-activity" },
  ], [apps]);

  // Publish the command set for the overlay's chip strip. Routing preserves
  // the old select() semantics exactly — host onCommand wins outright; the
  // self-sufficient default opens a fresh conversation in the mounted overlay.
  useEffect(() => registerConversationCommands({
    commands,
    select(command) {
      if (onCommand) {
        // The old palette dialog closed on select; mirror that for host-routed
        // commands so navigation (show-activity etc.) never lands behind the
        // open modal (cubic PR#391 finding).
        openVendoConversation({ close: true });
        onCommand(command);
        return;
      }
      if (command.kind === "new-conversation") {
        const opened = openVendoConversation({ newConversation: true });
        if (!opened && developmentMode()) {
          console.warn("[vendo] VendoPalette: \"New conversation\" opens the conversation surface — mount a VendoOverlay for it to land in (or supply onCommand).");
        }
        return;
      }
      if (developmentMode()) {
        console.warn(`[vendo] VendoPalette: "${command.label}" needs an onCommand handler to route (kind "${command.kind}").`);
      }
    },
  }), [commands, onCommand]);

  // ENG-223 — the programmatic opener seam. Open-only (no toggle): a CTA that
  // finds the surface already open should leave it open, not dismiss it.
  useEffect(() => registerPaletteOpener(() => {
    const opened = openVendoConversation();
    if (!opened && developmentMode()) {
      console.warn("[vendo] VendoPalette: nothing to open — mount a VendoOverlay for the conversation surface to land in.");
    }
  }), []);

  // The singleton keybinding (ENG-222). ⌘K TOGGLES the overlay — the
  // one-surface replacement for the old dialog toggle. The editable-target
  // guard is unconditional now (the palette no longer tracks an open state);
  // closing from inside the overlay's composer stays on Escape.
  const matcher = useMemo(() => resolveHotkeyMatcher(hotkey), [hotkey]);
  useEffect(() => {
    if (hotkey === false) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!matcher(event)) return;
      // Never steal a keystroke a HOST input owns — but the overlay's own
      // composer is ours: ⌘K from inside the open surface toggles it closed
      // (the old dialog's while-open behavior, one-surface edition).
      const insideOverlay = event.target instanceof HTMLElement && event.target.closest("#vendo-overlay-dialog") !== null;
      if (isEditableTarget(event.target) && !insideOverlay) return;
      event.preventDefault();
      const opened = openVendoConversation({ toggle: true });
      if (!opened && developmentMode()) {
        console.warn("[vendo] VendoPalette: ⌘K opens the conversation surface — mount a VendoOverlay for it to land in.");
      }
    };
    return registerPaletteHotkey(handler);
  }, [matcher, hotkey]);

  return null;
}
