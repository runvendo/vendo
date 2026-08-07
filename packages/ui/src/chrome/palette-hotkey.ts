/** ENG-222 — a singleton, host-collision-safe keybinding for VendoPalette.
 *
 * Each palette used to attach its OWN global keydown listener, so two mounted
 * palettes both toggled on a single ⌘K (double-toggle) and every mount raced
 * the host's own ⌘K wiring. Instead every palette shares ONE document listener
 * registered here, and a keypress is delivered to only the most-recently-mounted
 * palette — a singleton keybinding no matter how many providers/palettes mount.
 */

/** A chord the palette listens for, e.g. `{ key: "k", meta: true }`. An omitted
 * modifier is ignored (not required to be up), matching typical shortcut wiring. */
export interface HotkeyChord {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Configurable palette keybinding: a chord, a custom matcher, or `false` to
 * disable the keyboard opener entirely (the host wires its own). */
export type PaletteHotkey = HotkeyChord | ((event: KeyboardEvent) => boolean) | false;

type Handler = (event: KeyboardEvent) => void;

const stack: Handler[] = [];
let listening = false;

function dispatch(event: KeyboardEvent): void {
  // LIFO: only the top (most recently mounted) palette owns the keybinding, so a
  // second mounted palette can never double-toggle alongside the first.
  stack[stack.length - 1]?.(event);
}

/** Programmatic open, singleton-scoped like the keybinding (ENG-223). A palette
 * registers its own opener on mount; `openVendoPalette()` opens the most-recently
 * mounted one — the seam the VendoSlot empty-state CTA uses to open the palette
 * without simulating a keystroke. LIFO mirrors the hotkey stack. */
type Opener = () => void;
const openers: Opener[] = [];

export function registerPaletteOpener(open: Opener): () => void {
  openers.push(open);
  return () => {
    const index = openers.lastIndexOf(open);
    if (index >= 0) openers.splice(index, 1);
  };
}

/** Open the most-recently-mounted palette. Returns `false` when none is mounted,
 * so callers can fall back (the CTA is a no-op rather than a dead click). */
export function openVendoPalette(): boolean {
  const top = openers[openers.length - 1];
  if (!top) return false;
  top();
  return true;
}

/** Subscribe a palette to the shared keybinding; returns an unsubscribe. The
 * single document listener is attached on the first subscriber and removed when
 * the last one leaves. */
export function registerPaletteHotkey(handler: Handler): () => void {
  stack.push(handler);
  if (!listening) {
    // Listen on the window (not document): a bubbled keydown reaches it just the
    // same, and events dispatched directly at the window still arrive.
    globalThis.addEventListener("keydown", dispatch);
    listening = true;
  }
  return () => {
    const index = stack.lastIndexOf(handler);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0 && listening) {
      globalThis.removeEventListener("keydown", dispatch);
      listening = false;
    }
  };
}

/** Default binding — ⌘K (macOS) or Ctrl+K (elsewhere). */
const defaultMatch = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";

/** Resolve the configured keybinding into a matcher. `undefined` → default
 * ⌘K/Ctrl+K; `false` → never matches (opener disabled). */
export function resolveHotkeyMatcher(hotkey: PaletteHotkey | undefined): (event: KeyboardEvent) => boolean {
  if (hotkey === undefined) return defaultMatch;
  if (hotkey === false) return () => false;
  if (typeof hotkey === "function") return hotkey;
  const chord = hotkey;
  return (event: KeyboardEvent): boolean => {
    if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
    if (chord.meta !== undefined && event.metaKey !== chord.meta) return false;
    if (chord.ctrl !== undefined && event.ctrlKey !== chord.ctrl) return false;
    if (chord.shift !== undefined && event.shiftKey !== chord.shift) return false;
    if (chord.alt !== undefined && event.altKey !== chord.alt) return false;
    return true;
  };
}

/** A host editable element the palette must not steal keystrokes from while
 * closed (its own ⌘K, find-in-field, etc.). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}
