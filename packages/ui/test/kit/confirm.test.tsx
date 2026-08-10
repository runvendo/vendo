// @vitest-environment jsdom
/**
 * `confirm` — the Kit's confirmation step. The wire had no way to say "ask
 * first", so a destructive generated screen either fired on the first press or
 * hand-rolled a modal in an island; this is the prop that replaces both.
 *
 * The probe that grades a generated screen presses every enabled control on a
 * fresh page and, when a `[role=dialog]` is showing, presses the LAST control
 * inside it. Both halves of that contract are asserted here: nothing is
 * pressable before the confirmation opens, and the action hangs off its last
 * control.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../src/kit/forms/button.js";
import { Form } from "../../src/kit/forms/form.js";

/** Everything a person — or the click probe — can press. */
const ACTIONABLE = "button:not([disabled]), [role=button]:not([aria-disabled=true]), a[href]";

const pressable = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(ACTIONABLE)];

describe("Button confirm", () => {
  it("asks before it acts, and acts from the confirmation's last control", () => {
    const onClick = vi.fn();
    render(<Button label="Cancel transfer" variant="danger" onClick={onClick} confirm="Cancel Alex Rivera's transfer?" />);

    // One control on the un-pressed screen: a confirmation control rendered
    // hidden would be pressed by the probe and recorded as dead.
    expect(pressable()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));
    expect(onClick).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Cancel Alex Rivera's transfer?");

    const controls = [...dialog.querySelectorAll<HTMLElement>(ACTIONABLE)];
    expect(controls.map((control) => control.textContent)).toEqual(["Never mind", "Cancel transfer"]);
    fireEvent.click(controls[controls.length - 1]!);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("dismissing fires nothing and gives the button back", () => {
    const onClick = vi.fn();
    render(<Button label="Cancel transfer" onClick={onClick} confirm="Sure?" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));
    fireEvent.click(screen.getByRole("button", { name: "Never mind" }));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pressable()).toHaveLength(1);
  });

  it("without confirm the press still acts immediately", () => {
    const onClick = vi.fn();
    render(<Button label="Remind all" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Remind all" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Form confirm", () => {
  it("holds the submit until the confirmation is answered", () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} submitLabel="Cancel transfer" confirm="Cancel this transfer?" />);
    expect(pressable()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));
    expect(onSubmit).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    const controls = [...dialog.querySelectorAll<HTMLElement>(ACTIONABLE)];
    fireEvent.click(controls[controls.length - 1]!);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
