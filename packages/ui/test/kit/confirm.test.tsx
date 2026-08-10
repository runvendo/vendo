// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../src/kit/forms/button.js";
import { Form } from "../../src/kit/forms/form.js";

describe("confirm (the destructive step)", () => {
  it("asks instead of acting, and only the confirmation runs the tool", () => {
    const onClick = vi.fn();
    render(<Button label="Cancel transfer" variant="danger" onClick={onClick} confirm="Cancel Alex Rivera's transfer?" />);

    // Nothing is mounted until it is asked: a hidden control still reads as a
    // control to anything walking the page, and would read as a dead one.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));
    expect(onClick).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Cancel Alex Rivera's transfer?");
    expect(dialog.textContent).toContain("Cancel Alex Rivera's transfer?");

    // The primary sits LAST, after the way out: a reader that answers a
    // confirmation by taking its last control must land on the action.
    const controls = within(dialog).getAllByRole("button");
    expect(controls.map((control) => control.textContent)).toEqual(["Keep it", "Cancel transfer"]);

    fireEvent.click(controls[controls.length - 1]!);
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps it when the way out is taken", () => {
    const onClick = vi.fn();
    render(<Button label="Delete" onClick={onClick} confirm="Delete this?" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep it" }));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gates a Form's submit — including the Enter-in-a-field path", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <Form onSubmit={onSubmit} submitLabel="Cancel transfer" confirm="Cancel this transfer?">
        <input aria-label="note" />
      </Form>,
    );
    const form = container.querySelector("form")!;

    // Every way in answers the question: the press, and a submit that arrived
    // without one (Enter in a field, or the jail's re-dispatched submit).
    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel transfer" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();

    // And the answer is spent: the next submission asks again.
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("leaves an unconfirmed Form submitting straight through", () => {
    const onSubmit = vi.fn();
    const { container } = render(<Form onSubmit={onSubmit} submitLabel="Add client" />);
    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
