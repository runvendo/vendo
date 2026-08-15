// @vitest-environment jsdom
/**
 * The Base UI migration's gate. Tabs now renders on `@base-ui/react`'s Tabs
 * parts instead of hand-rolled buttons, so the two things a swapped internal
 * can silently take away are asserted here against the REAL controls:
 *
 *  1. The `{$handler}` bridge (kit/handler.ts). Its known failure mode is a
 *     migrated control that freezes mid-interaction — controlled by the screen,
 *     but the screen never hears the change, so the box never moves again.
 *     Every case below drives a LIVE screen: the handler writes state, the
 *     re-render comes back through the control, and the assertion is made on
 *     the second and third interaction, which is where a freeze shows.
 *  2. The a11y contract Base UI is supposed to keep: the roles the renderer's
 *     consumers query by, and the roving tab order a tablist owes a keyboard.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { markHandlerCallback } from "../../src/kit/handler.js";
import { Checkbox } from "../../src/kit/forms/checkbox.js";
import { Input } from "../../src/kit/forms/input.js";
import { Select } from "../../src/kit/forms/select.js";
import { Tabs } from "../../src/kit/feedback/tabs.js";

/** A live screen: the `{$handler}` callback owns the value and re-renders it. */
function Screen<T>({ initial, render: renderControl }: {
  initial: T;
  render: (value: T, fire: (event?: unknown) => void) => React.ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const [fire] = useState(() =>
    markHandlerCallback((event?: unknown) => {
      const target = (event as { target?: { value?: T; checked?: T } }).target ?? {};
      setValue((target.checked ?? target.value) as T);
    }));
  return <>{renderControl(value, fire)}</>;
}

describe("a screen-bound control keeps moving", () => {
  it("types through an Input keystroke after keystroke", () => {
    render(<Screen initial="" render={(value, fire) => <Input label="Find" value={value} onChange={fire} />} />);
    const box = screen.getByLabelText("Find") as HTMLInputElement;

    // Three keystrokes, each asserted: a control that freezes passes the first
    // one and then stops, so only the later characters catch it.
    for (const typed of ["h", "ha", "har"]) {
      fireEvent.change(box, { target: { value: typed } });
      expect(box.value).toBe(typed);
    }
  });

  it("toggles a Checkbox back and forth", () => {
    render(
      <Screen initial={false} render={(value, fire) => <Checkbox label="Paid" checked={value} onChange={fire} />} />,
    );
    const box = () => screen.getByRole("checkbox", { name: "Paid" }) as HTMLInputElement;

    fireEvent.click(box());
    expect(box().checked).toBe(true);
    // The toggle BACK is the freeze detector: a stuck control reports the first
    // change and then holds whatever the screen last said.
    fireEvent.click(box());
    expect(box().checked).toBe(false);
  });

  it("changes a Select twice", () => {
    render(
      <Screen
        initial="open"
        render={(value, fire) => <Select label="Status" value={value} options={["open", "paid", "void"]} onChange={fire} />}
      />,
    );
    const box = () => screen.getByLabelText("Status") as HTMLSelectElement;

    fireEvent.change(box(), { target: { value: "paid" } });
    expect(box().value).toBe("paid");
    fireEvent.change(box(), { target: { value: "void" } });
    expect(box().value).toBe("void");
  });

  it("switches Tabs and switches back", () => {
    render(
      <Tabs tabs={["Overview", "Overdue"]}>
        <p>overview body</p>
        <p>overdue body</p>
      </Tabs>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Overdue" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("overdue body");
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("overview body");
  });
});

describe("the migrated Tabs keeps its a11y contract", () => {
  const view = () => render(
    <Tabs tabs={["Overview", "Overdue", { label: "Void", disabled: true }]}>
      <p>overview body</p>
      <p>overdue body</p>
      <p>void body</p>
    </Tabs>,
  );

  it("names the roles a consumer queries by, and points each at the other", () => {
    view();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Overdue", "Void"]);
    expect(screen.getByRole("tablist")).toBeTruthy();

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel.id);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("holds ONE tab stop, so the bar is one stop in the page's tab order", () => {
    view();
    // Roving tabindex. Where the arrow keys then take that stop is a REAL
    // browser's question: Base UI drives its roving focus off trusted focus
    // events, which jsdom's synthetic ones cannot stand in for, so the arrow
    // walk is proven in the headed run rather than faked here.
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("marks a disabled tab and refuses to select it", () => {
    view();
    const third = screen.getAllByRole("tab")[2] as HTMLElement;
    expect(third.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(third);
    expect(screen.getByRole("tabpanel").textContent).toBe("overview body");
  });
});
