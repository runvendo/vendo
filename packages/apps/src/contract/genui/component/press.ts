/**
 * The press — every control the screen paints, activated once, to answer the
 * one question no compiler asks: does this button DO anything?
 *
 * A screen can compile, type-check, and paint a perfect-looking "Book
 * appointment" button whose handler falls out of an early `return` and reaches
 * no tool and no state. Every stage before this one reads the screen; this one
 * USES it. A control is judged on what a press produces, and there are only
 * three outcomes: it asks the host for a tool call, it changes what is painted,
 * or it does nothing at all — and the third is a dead control.
 *
 * NOTHING IS PERFORMED. A `tools.x()` inside a handler records an {@link Intent}
 * and returns a promise nobody here resolves (./boot.ts) — the tool bridge is
 * the ONLY way anything leaves the VM, and this file never calls
 * `ScreenInstance.settle`. So pressing a "Delete everything" button observes the
 * request and performs no part of it, against a live host or any other.
 *
 * A FRESH SCREEN PER PRESS. A press that opens a dialog or fills a field leaves
 * the next press somewhere the person never was, and its handler ids may name
 * nodes that are gone. Booting again costs about four milliseconds, which is
 * cheaper than any reasoning about what the last press left behind — so every
 * control is judged on the screen the person is FIRST shown.
 */
import { isHandlerRef, type FlatTree, type InertControl, type ScreenInstance } from "./types.js";

/**
 * The props a person activates with nothing but the press itself.
 *
 * Deliberately not "every function-valued prop". A value event — `onChange` on
 * an Input or a Select, `onSelect` on a Menu — carries the thing the person
 * chose, and firing one with no value would report `(e) => setId(e.target.value)`
 * as doing nothing when the fault is the press, not the screen. `onClose` is
 * left out for the same reason from the other end: a Modal that is not open
 * closes to the state it is already in, so its perfectly good handler would read
 * as dead.
 *
 * Matched by NAME rather than by catalog entry, so a host component that follows
 * the convention is pressed like a Kit one.
 */
const ACTIVATION_PROPS: ReadonlySet<string> = new Set(["onClick", "onSubmit"]);

/**
 * How many controls one screen is pressed on.
 *
 * A screen with more than this many buttons has them from a `.map` over rows,
 * and every one of those shares a single handler in the source — so pressing
 * sixty-four of them finds the dead one exactly as well as pressing four
 * hundred would, at a bounded cost. A screen that really does paint sixty-five
 * DIFFERENT controls is not a shape anybody writes.
 */
const MAX_PRESSES = 64;

interface Pressable extends InertControl {
  handler: string;
}

/**
 * Every control on the screen as it first paints, in paint order.
 *
 * Two things are not on that screen and are therefore not pressed. A DISABLED
 * control, because a person cannot press one — grading it would refuse a screen
 * for being careful, and it is the same control the benchmark's own robot walks
 * past. And anything under a CLOSED overlay (`open={false}` — a Modal, a Sheet, a
 * Toast), because the emitter hands over the children a component wrote whether
 * the renderer will show them or not: the Cancel button inside a shut dialog
 * would otherwise be pressed in a state where doing nothing is the right answer.
 */
const pressable = (flat: FlatTree): Pressable[] => {
  const found: Pressable[] = [];
  const walk = (id: string): void => {
    const node = flat.nodes[id];
    if (node === undefined || node.props["open"] === false) return;
    if (node.props["disabled"] !== true) {
      for (const [prop, value] of Object.entries(node.props)) {
        if (ACTIVATION_PROPS.has(prop) && isHandlerRef(value)) {
          found.push({ node: id, prop, handler: value.$handler });
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(flat.root);
  return found;
};

/**
 * Press every control on `painted` and report the ones that did nothing.
 *
 * `boot` mints a screen from the same input that produced `painted` — the
 * caller's, because only the caller knows which engine and which budget this
 * venue runs on. A boot that fails is left to raise: a gate that could not run
 * the screen must not read its own silence as a screen with no dead controls.
 */
export function pressControls(painted: FlatTree, boot: () => ScreenInstance): InertControl[] {
  const inert: InertControl[] = [];
  for (const { node, prop, handler } of pressable(painted).slice(0, MAX_PRESSES)) {
    const screen = boot();
    try {
      const before = JSON.stringify(screen.tree());
      const fired = screen.fire(handler);
      if (fired.intents.length === 0 && JSON.stringify(fired.tree) === before) inert.push({ node, prop });
    } catch {
      // A handler that threw, or that burned its budget, is not a handler that
      // did NOTHING — it is a different defect, and this check is not the one
      // that names it. The screen stays standing either way (./boot.ts).
    } finally {
      // A dispose that throws is not the control's verdict.
      try { screen.dispose(); } catch { /* ignore */ }
    }
  }
  return inert;
}
