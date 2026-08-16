import { describe, expect, it } from "vitest";
import { KIT_OVERLAY_SPECS } from "../../../src/contract/kit/overlay.js";
import { validateProps } from "../../../src/contract/kit/schema.js";
import { KIT_SPECS, kitSpec } from "../../../src/contract/kit/specs.js";

/**
 * The overlay bricks' own contract. What separates them from every other brick
 * is the open/close pair, so the pair is what this pins: a consumer that routes
 * an overlay to the chrome host reads it from the map, and a map that named a
 * prop the spec does not declare would route a node it cannot then open.
 */
describe("the overlay specs", () => {
  it("covers exactly the three overlay bricks", () => {
    expect(Object.keys(KIT_OVERLAY_SPECS).sort()).toEqual(["Modal", "Sheet", "Toast"]);
  });

  it("names, on every overlay, props its Kit spec actually declares", () => {
    for (const [name, overlay] of Object.entries(KIT_OVERLAY_SPECS)) {
      const spec = kitSpec(name);
      expect(spec, name).toBeDefined();
      expect(spec!.props[overlay.openProp], `${name}.${overlay.openProp}`).toBeDefined();
      expect(spec!.props[overlay.closeProp], `${name}.${overlay.closeProp}`).toBeDefined();
      // The open prop is the one a screen cannot leave out: without it the
      // overlay has no truth to follow and would sit there permanently down.
      expect(spec!.props[overlay.openProp]!.required, `${name}.${overlay.openProp} required`).toBe(true);
    }
  });

  it("says a toast is not dismissable — it leaves on its own timer", () => {
    expect(KIT_OVERLAY_SPECS.Modal!.dismissable).toBe(true);
    expect(KIT_OVERLAY_SPECS.Sheet!.dismissable).toBe(true);
    expect(KIT_OVERLAY_SPECS.Toast!.dismissable).toBe(false);
  });

  it("is derived from the specs — a name that is not a Kit component cannot survive", () => {
    for (const name of Object.keys(KIT_OVERLAY_SPECS)) {
      expect(KIT_SPECS.some((spec) => spec.name === name), name).toBe(true);
    }
  });

  it("validates the props each overlay was given", () => {
    const modal = kitSpec("Modal")!;
    expect(validateProps(modal, { open: true, onClose: "ui.cancel", title: "Send reminders?", size: "large" }).success).toBe(true);
    expect(validateProps(modal, { title: "no open prop" }).success).toBe(false);
    expect(validateProps(modal, { open: true, onClose: "ui.cancel", size: "enormous" }).success).toBe(false);

    const sheet = kitSpec("Sheet")!;
    expect(validateProps(sheet, { open: true, onClose: "ui.close", side: "left" }).success).toBe(true);
    expect(validateProps(sheet, { open: true, onClose: "ui.close", side: "diagonal" }).success).toBe(false);

    const toast = kitSpec("Toast")!;
    expect(validateProps(toast, { open: true, message: "Sent.", tone: "success", duration: 4000 }).success).toBe(true);
    expect(validateProps(toast, { open: true }).success).toBe(false);
  });

  it("refuses a controlled overlay with no way out", () => {
    // Every dismissal affordance a dialog has — the X, Esc, the backdrop — does
    // nothing but call `onClose`. Optional, it let a generated screen raise a
    // modal that NOTHING could take down, with the person shut behind it.
    for (const name of ["Modal", "Sheet"]) {
      const spec = kitSpec(name)!;
      expect(spec.props.onClose!.required, `${name}.onClose`).toBe(true);
      expect(validateProps(spec, { open: true, title: "Trapped" }).success, name).toBe(false);
      expect(validateProps(spec, { open: true, onClose: "ui.cancel", title: "Fine" }).success, name).toBe(true);
    }
    // A Toast is NOT in that class: it takes itself down on its own timer, so
    // `onClose` stays optional — it is how the screen learns, not the way out.
    expect(kitSpec("Toast")!.props.onClose!.required ?? false).toBe(false);
    expect(validateProps(kitSpec("Toast")!, { open: true, message: "Sent." }).success).toBe(true);
  });

  it("gives Modal and Sheet the header and footer slots, and Toast none", () => {
    expect(Object.keys(kitSpec("Modal")!.slots ?? {}).sort()).toEqual(["footer", "header"]);
    expect(Object.keys(kitSpec("Sheet")!.slots ?? {}).sort()).toEqual(["footer", "header"]);
    expect(kitSpec("Toast")!.slots).toBeUndefined();
  });
});
