// @vitest-environment jsdom
/**
 * The eight bricks Base UI brought in, and the four the Kit handed over to it.
 *
 * Each one is asserted through the REAL control, on the two things a headless
 * library can silently take away: the value it reports back (a migrated control
 * that freezes reports the first change and then nothing), and the roles and
 * aria a consumer queries by. Where the answer is a keyboard's, it is a
 * keyboard that asks — with one exception, stated at the bottom: Base UI drives
 * roving focus off TRUSTED focus events, which jsdom's synthetic ones cannot
 * stand in for, so the arrow WALK is proven in the headed run instead of faked
 * here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { markHandlerCallback } from "../../src/kit/handler.js";
import { Accordion } from "../../src/kit/feedback/accordion.js";
import { Menu } from "../../src/kit/feedback/menu.js";
import { Tooltip } from "../../src/kit/feedback/tooltip.js";
import { Combobox } from "../../src/kit/forms/combobox.js";
import { DateRange } from "../../src/kit/forms/date-range.js";
import { Radio } from "../../src/kit/forms/radio.js";
import { SegmentedControl } from "../../src/kit/forms/segmented-control.js";
import { Slider } from "../../src/kit/forms/slider.js";
import { Switch } from "../../src/kit/forms/switch.js";
import { Progress } from "../../src/kit/charts/progress.js";

/**
 * jsdom 25 ships no `PointerEvent`, and Base UI's Switch and Radio forward a
 * click to their hidden input by CONSTRUCTING one. Without this the roots throw
 * "PointerEvent is not a constructor" and the control never moves — an artifact
 * of the environment, not of the component, which the headed run then proves.
 */
if (typeof window.PointerEvent !== "function") {
  window.PointerEvent = class extends MouseEvent {} as unknown as typeof PointerEvent;
}

afterEach(cleanup);

const clients = [
  { id: "c1", name: "Hartwell" },
  { id: "c2", name: "Acme" },
];

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

describe("Switch", () => {
  it("is a switch by role, and a screen-bound one keeps flipping", () => {
    render(<Screen initial={false} render={(on, fire) => <Switch label="Notify" checked={on} onChange={fire} />} />);
    const box = () => screen.getByRole("switch", { name: "Notify" });

    fireEvent.click(box());
    expect(box().getAttribute("aria-checked")).toBe("true");
    // The flip BACK is the freeze detector.
    fireEvent.click(box());
    expect(box().getAttribute("aria-checked")).toBe("false");
  });

  it("reports the new state to a plain handler", () => {
    const onChange = vi.fn();
    render(<Switch label="Notify" onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Notify" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Radio", () => {
  it("maps raw tool output through labelField/valueField and reports the value", () => {
    const onChange = vi.fn();
    render(<Radio label="Client" options={clients} labelField="name" valueField="id" onChange={onChange} />);

    expect(screen.getAllByRole("radio").length).toBe(2);
    fireEvent.click(screen.getByRole("radio", { name: "Acme" }));
    expect(onChange).toHaveBeenCalledWith("c2");
  });

  it("keeps moving on a screen", () => {
    render(
      <Screen initial="c1" render={(value, fire) => (
        <Radio label="Client" options={clients} labelField="name" valueField="id" value={value} onChange={fire} />
      )} />,
    );
    const at = (name: string) => screen.getByRole("radio", { name });

    fireEvent.click(at("Acme"));
    expect(at("Acme").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(at("Hartwell"));
    expect(at("Hartwell").getAttribute("aria-checked")).toBe("true");
  });

  it("refuses an option the TOOL marked disabled, and heads each run", () => {
    // Off the raw item's own `disabled` and `group` keys: the item that cannot be
    // picked is the one the tool said so about, so no prop names either.
    const onChange = vi.fn();
    const { container } = render(
      <Radio
        label="Plan"
        options={[
          { id: "p1", name: "Starter", group: "Monthly" },
          { id: "p2", name: "Growth", group: "Monthly", disabled: true },
          { id: "p3", name: "Starter, yearly", group: "Yearly" },
        ]}
        labelField="name"
        valueField="id"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Growth" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Starter" }));
    expect(onChange).toHaveBeenCalledWith("p1");

    // One heading per run, where the run's first member stood.
    expect([...container.querySelectorAll('[data-kit="Radio"] > span')].map((head) => head.textContent))
      .toEqual(["Monthly", "Yearly"]);
  });
});

describe("Slider", () => {
  it("carries the aria a range owes, and prints its value when asked", () => {
    const { container } = render(<Slider label="Budget" value={40} min={0} max={200} step={5} showValue />);
    expect(screen.getByRole("slider", { name: "Budget" }).getAttribute("aria-valuenow")).toBe("40");
    // The ends live on the nested range input Base UI hides behind the thumb.
    const input = container.querySelector("input[type=range]") as HTMLInputElement;
    expect([input.min, input.max, input.step]).toEqual(["0", "200", "5"]);
    expect(screen.getByText("40")).toBeTruthy();
  });

  it("steps on an arrow key and reports the new number", () => {
    const onChange = vi.fn();
    render(<Slider label="Budget" value={40} min={0} max={200} step={5} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Budget" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(45);
  });
});

describe("SegmentedControl", () => {
  it("presses one segment at a time and reports its value", () => {
    render(<Screen initial="Week" render={(value, fire) => (
      <SegmentedControl items={["Week", "Month", "Year"]} value={value} onChange={fire} />
    )} />);
    const at = (name: string) => screen.getByRole("radio", { name });

    fireEvent.click(at("Month"));
    expect(at("Month").getAttribute("aria-checked")).toBe("true");
    expect(at("Week").getAttribute("aria-checked")).toBe("false");
    // The second press is the freeze detector.
    fireEvent.click(at("Year"));
    expect(at("Year").getAttribute("aria-checked")).toBe("true");
  });

  it("takes {value,label} items and refuses a disabled segment", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        items={[{ value: "w", label: "Week" }, { value: "m", label: "Month", disabled: true }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(onChange).toHaveBeenCalledWith("w");

    onChange.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * PRESSING THE ACTIVE SEGMENT AGAIN SAYS NOTHING.
   *
   * ToggleGroup un-presses what is already pressed, so a second press on the
   * live segment reported an EMPTY selection — and this bar spelled that as the
   * value `""`, a value no segment has. A screen handed it straight to a tool
   * call, and the filter switch it was reading went blank on the way. A bar of
   * mutually exclusive choices is single-choice like Tabs: one of them is always
   * the answer, and re-pressing it is a no-op.
   */
  it("says nothing when the segment already pressed is pressed again", () => {
    const onChange = vi.fn();
    render(<SegmentedControl items={["Week", "Month"]} onChange={onChange} />);
    const week = () => screen.getByRole("radio", { name: "Week" });

    fireEvent.click(week());
    expect(onChange).toHaveBeenCalledWith("Week");

    onChange.mockClear();
    fireEvent.click(week());
    expect(onChange).not.toHaveBeenCalled();
    expect(week().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps a screen-bound bar on its choice through the same second press", () => {
    render(<Screen initial="Week" render={(value, fire) => (
      <SegmentedControl items={["Week", "Month"]} value={value} onChange={fire} />
    )} />);
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(screen.getByRole("radio", { name: "Week" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Combobox", () => {
  it("is a text box over raw tool output, and typing narrows the list", async () => {
    render(<Combobox label="Client" options={clients} labelField="name" valueField="id" placeholder="Search" />);
    const box = screen.getByLabelText("Client") as HTMLInputElement;

    // `inputType` is what tells Base UI a human typed rather than a password
    // manager filling the box, and it is the difference between the list
    // opening and staying shut. Both names carry an "a"; only one carries "acm".
    fireEvent.input(box, { target: { value: "a" }, inputType: "insertText" });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Hartwell", "Acme"]);

    fireEvent.input(box, { target: { value: "acm" }, inputType: "insertText" });
    await waitFor(() => {
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Acme"]);
    });
  });

  it("reports the chosen item's value, not its label", async () => {
    const onChange = vi.fn();
    render(<Combobox label="Client" options={clients} labelField="name" valueField="id" onChange={onChange} />);

    fireEvent.input(screen.getByLabelText("Client"), { target: { value: "acm" }, inputType: "insertText" });
    fireEvent.click(await screen.findByRole("option", { name: "Acme" }));
    expect(onChange).toHaveBeenCalledWith("c2");
  });

  it("refuses an option the TOOL marked disabled, and heads each run", async () => {
    const onChange = vi.fn();
    render(
      <Combobox
        label="Client"
        options={[
          { id: "c1", name: "Hartwell", group: "Active" },
          { id: "c2", name: "Acme", group: "Dormant", disabled: true },
        ]}
        labelField="name"
        valueField="id"
        onChange={onChange}
      />,
    );
    fireEvent.input(screen.getByLabelText("Client"), { target: { value: "a" }, inputType: "insertText" });

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Hartwell", "Acme"]);
    // Each run is a group, labelled — which is what names it to a screen reader.
    expect(screen.getAllByRole("group").map((run) => run.firstElementChild?.textContent)).toEqual(["Active", "Dormant"]);

    fireEvent.click(options[1] as HTMLElement);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves an ungrouped list flat — no heading, no group", async () => {
    render(<Combobox label="Client" options={clients} labelField="name" valueField="id" />);
    fireEvent.input(screen.getByLabelText("Client"), { target: { value: "a" }, inputType: "insertText" });

    expect((await screen.findAllByRole("option")).length).toBe(2);
    expect(screen.queryAllByRole("group")).toEqual([]);
  });
});

describe("DateRange", () => {
  /** The trigger prints the range in the host's locale, so it is addressed by
   *  its Kit mark rather than by text this test would have to guess. */
  const open = async (container: HTMLElement) => {
    fireEvent.click(container.querySelector('[data-kit="DateRange"]') as HTMLElement);
    return screen.findByRole("grid");
  };

  it("reports a start and an end once both are picked", async () => {
    const onChange = vi.fn();
    const { container } = render(<DateRange label="Period" start="2026-03-01" onChange={onChange} />);
    await open(container);

    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "12" }));
    expect(onChange).toHaveBeenCalledWith({ start: "2026-03-04", end: "2026-03-12" });
  });

  it("orders the pair, so picking the later day first still reads forwards", async () => {
    const onChange = vi.fn();
    const { container } = render(<DateRange label="Period" start="2026-03-01" onChange={onChange} />);
    await open(container);

    fireEvent.click(screen.getByRole("button", { name: "12" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(onChange).toHaveBeenCalledWith({ start: "2026-03-04", end: "2026-03-12" });
  });

  it("forgets a half-made range when the calendar is dismissed", async () => {
    // The abandoned-endpoint bug: the pending first pick used to survive
    // dismissal, so the next click in a REOPENED calendar completed a range the
    // person had walked away from, and fired it as a real answer.
    const onChange = vi.fn();
    const { container } = render(<DateRange label="Period" start="2026-03-01" onChange={onChange} />);
    await open(container);
    fireEvent.click(screen.getByRole("button", { name: "10" }));

    fireEvent.keyDown(await screen.findByRole("grid"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());

    await open(container);
    fireEvent.click(screen.getByRole("button", { name: "15" }));
    expect(onChange).not.toHaveBeenCalled();

    // …and the reopened calendar is taking a FRESH range, not repairing the old.
    fireEvent.click(screen.getByRole("button", { name: "20" }));
    expect(onChange).toHaveBeenCalledWith({ start: "2026-03-15", end: "2026-03-20" });
  });

  it("refuses a day outside min/max", async () => {
    const onChange = vi.fn();
    const { container } = render(<DateRange label="Period" start="2026-03-01" min="2026-03-10" onChange={onChange} />);
    await open(container);

    expect((screen.getByRole("button", { name: "4" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    fireEvent.click(screen.getByRole("button", { name: "12" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Menu", () => {
  const items = [{ label: "Send reminder", value: "remind" }, { label: "Void", value: "void", disabled: true }];

  it("opens on its trigger and reports the chosen entry's value", async () => {
    const onSelect = vi.fn();
    render(<Menu label="Actions" items={items} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Send reminder" }));
    expect(onSelect).toHaveBeenCalledWith("remind");
  });

  it("closes on Esc without choosing anything", async () => {
    const onSelect = vi.fn();
    render(<Menu label="Actions" items={items} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Children used to WIN over `items`, wrapped one per entry in an item with no
  // handler: the menu opened, listed them, highlighted them on hover and did
  // nothing at all when one was chosen. `items` + `onSelect` is the only API now —
  // the floor refuses a nested Menu and names that pair as the fix — so all this
  // brick has to do is stop pretending children work.
  it("ignores children — items are the only entries, and they still fire", async () => {
    const onSelect = vi.fn();
    render(
      <Menu label="Actions" items={items} onSelect={onSelect}>
        <span>Export CSV</span>
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));

    const entries = await screen.findAllByRole("menuitem");
    expect(entries.map((entry) => entry.textContent)).toEqual(["Send reminder", "Void"]);
    expect(screen.queryByText("Export CSV")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Send reminder" }));
    expect(onSelect).toHaveBeenCalledWith("remind");
  });
});

/** `aria-describedby` is an ID list, so assertions read it as one. */
const described = (element: HTMLElement): string[] =>
  (element.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean);

/** Base UI opens a tooltip off a NATIVE `mouseenter` on the trigger — not the
 *  delegated one React synthesizes — and then waits out the hover delay. */
const hover = (trigger: HTMLElement) => {
  trigger.dispatchEvent(new window.MouseEvent("mouseenter"));
  fireEvent.mouseMove(trigger);
};

describe("Tooltip", () => {
  it("shows its label on hover", async () => {
    render(<Tooltip label="Sent 3 days ago"><span>clock</span></Tooltip>);

    const trigger = screen.getByText("clock").parentElement as HTMLElement;
    hover(trigger);
    expect((await screen.findByRole("tooltip", {}, { timeout: 3000 })).textContent).toBe("Sent 3 days ago");
  });

  it("describes the control itself, and adds no second tab stop around it", () => {
    // The wrapper used to be focusable unconditionally and to wear the
    // description itself, so a wrapped button cost two stops and the one that
    // mattered — the button — arrived undescribed.
    const { container } = render(<Tooltip label="Sent 3 days ago"><button type="button">Resend</button></Tooltip>);
    const trigger = container.querySelector('[data-kit="Tooltip"]') as HTMLElement;
    const button = screen.getByRole("button", { name: "Resend" });

    expect(trigger.getAttribute("tabindex")).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
    expect(button.getAttribute("aria-describedby")).not.toBeNull();
  });

  it("keeps a description the control already had, rather than replacing it", () => {
    const { container } = render(
      <Tooltip label="Sent 3 days ago"><button type="button" aria-describedby="its-own">Resend</button></Tooltip>,
    );
    const described = screen.getByRole("button", { name: "Resend" }).getAttribute("aria-describedby");
    expect(described?.split(" ")).toContain("its-own");
    expect(described?.split(" ").length).toBe(2);
    expect(container.querySelector('[data-kit="Tooltip"]')?.getAttribute("tabindex")).toBeNull();
  });

  it("removes only its OWN hint on unmount, keeping a description that arrived meanwhile", () => {
    // The snapshot-and-restore bug: cleanup used to reinstate the list as it
    // stood at MOUNT, so a description written while the Tooltip was open — a
    // validation error id, the one that matters most — was erased on the way
    // out, and the stale one came back.
    function Host({ swapped }: { swapped: boolean }) {
      return (
        <Tooltip label="Sent 3 days ago">
          {swapped
            ? <a href="#next">Next</a>
            : <button type="button" aria-describedby="initial-description">Resend</button>}
        </Tooltip>
      );
    }
    const view = render(<Host swapped={false} />);
    const button = screen.getByRole("button", { name: "Resend" });
    expect(described(button)).toContain("initial-description");
    expect(described(button).length).toBe(2);

    // Another owner rewrites the description while this Tooltip holds the
    // control. A field turning invalid is exactly this.
    button.setAttribute("aria-describedby", "dynamic-description");

    // …and now the Tooltip lets this control go.
    view.rerender(<Host swapped />);

    expect(described(button)).toEqual(["dynamic-description"]);
  });

  it("keeps the wrapper reachable when the control it wraps is DISABLED", () => {
    // A disabled control is skipped by sequential navigation, so treating it as
    // the reachable stop left the hint with no way in — and "why is this
    // disabled?" is the question a tooltip most often answers.
    const { container } = render(
      <Tooltip label="Awaiting approval"><button type="button" disabled>Send</button></Tooltip>,
    );
    const trigger = container.querySelector('[data-kit="Tooltip"]') as HTMLElement;

    expect(trigger.getAttribute("tabindex")).toBe("0");
    expect(trigger.getAttribute("aria-describedby")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-describedby")).toBeNull();
  });

  it("still stands in for a child that could not be reached at all", () => {
    // A bare glyph is not focusable, so the wrapper IS the only way to the hint.
    const { container } = render(<Tooltip label="Sent 3 days ago"><span>clock</span></Tooltip>);
    const trigger = container.querySelector('[data-kit="Tooltip"]') as HTMLElement;
    expect(trigger.getAttribute("tabindex")).toBe("0");
    expect(trigger.getAttribute("aria-describedby")).not.toBeNull();
  });

  it("lets the content slot win over the label shorthand", async () => {
    render(
      <Tooltip label="short" content={<strong>the long form</strong>}>
        <span>clock</span>
      </Tooltip>,
    );

    const trigger = screen.getByText("clock").parentElement as HTMLElement;
    hover(trigger);
    expect((await screen.findByRole("tooltip", {}, { timeout: 3000 })).textContent).toBe("the long form");
  });
});

describe("the migrated bricks keep what the swap could have taken", () => {
  it("Accordion points its trigger at its panel, and honours multiple", () => {
    render(
      <Accordion
        multiple
        items={[{ label: "Terms", content: <p>the terms</p> }, { label: "FAQ", content: <p>the faq</p> }]}
      />,
    );
    const trigger = (name: string) => screen.getByRole("button", { name });

    expect(trigger("Terms").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger("Terms"));
    fireEvent.click(trigger("FAQ"));
    // Without `multiple` the first would have closed; both open is the proof.
    expect(screen.getByText("the terms")).toBeTruthy();
    expect(screen.getByText("the faq")).toBeTruthy();
    expect(trigger("Terms").getAttribute("aria-controls")).toBe(screen.getByText("the terms").parentElement?.id);
  });

  it("Progress states the value triple a screen reader reads", () => {
    render(<Progress value={30} max={60} label="Savings" showValue />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
  });
});

/**
 * NOT asserted here, on purpose: the arrow-key WALK through Menu's items,
 * SegmentedControl's segments and Select's options. Base UI moves that roving
 * focus off trusted focus events, which `fireEvent` cannot produce, so a jsdom
 * assertion would either fail against working code or pass against broken code.
 * The walk is proven in the headed browser run instead.
 */
