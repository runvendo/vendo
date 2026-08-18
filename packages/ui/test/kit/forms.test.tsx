// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VendoProvider } from "../../src/context.js";
import { Button } from "../../src/kit/forms/button.js";
import { Checkbox } from "../../src/kit/forms/checkbox.js";
import { DatePicker } from "../../src/kit/forms/date-picker.js";
import { Disclaimer } from "../../src/kit/forms/disclaimer.js";
import { Form } from "../../src/kit/forms/form.js";
import { Input } from "../../src/kit/forms/input.js";
import { Select } from "../../src/kit/forms/select.js";
import { Textarea } from "../../src/kit/forms/textarea.js";

describe("Button (action-gated)", () => {
  it("invokes its bound action on click", () => {
    const onClick = vi.fn();
    render(<Button label="Remind all" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Remind all" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(<Button label="Send" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("wears a lucide glyph before its label", () => {
    const { container } = render(<Button label="Send" icon="send" />);
    const button = screen.getByRole("button", { name: "Send" });
    expect(container.querySelector('[data-icon="send"]')).not.toBeNull();
    // Before the label, which is the order the action reads in.
    expect(button.firstElementChild?.getAttribute("data-icon")).toBe("send");
  });

  it("spins in the glyph's place while loading, and refuses the second click", () => {
    const onClick = vi.fn();
    const { container } = render(<Button label="Send" icon="send" loading onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Send" });

    expect(container.querySelector("[data-kit-spinner]")).not.toBeNull();
    expect(container.querySelector('[data-icon="send"]')).toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("true");

    // A slow tool must not be sent twice — the whole reason the prop exists.
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    // Busy, not switched off: it keeps its fill, so it still reads as a button.
    expect((button as HTMLButtonElement).style.opacity).toBe("1");
    // It TURNS by default — the half the setting below takes away.
    expect(container.querySelector("[data-kit-spinner] animateTransform")).not.toBeNull();
  });

  it("holds the spinner still where the host asked for reduced motion", () => {
    // Everything else the Kit moves goes through `transitionFor`, which collapses
    // to 0ms on this setting. No CSS can pause a SMIL animation, so the mark has
    // to read the theme itself — otherwise the spinner is the one thing in the Kit
    // that keeps moving through the person's own answer.
    const { container } = render(
      <VendoProvider theme={{ motion: "reduced" }}>
        <Button label="Send" loading />
      </VendoProvider>,
    );
    expect(container.querySelector("[data-kit-spinner]")).not.toBeNull();
    expect(container.querySelector("[data-kit-spinner] animateTransform")).toBeNull();
  });
});

describe("Select over raw object arrays", () => {
  const clients = [
    { id: "c1", name: "Hartwell" },
    { id: "c2", name: "Acme" },
  ];

  it("maps options via labelField/valueField", () => {
    render(<Select label="Client" options={clients} labelField="name" valueField="id" />);
    const option = screen.getByRole("option", { name: "Hartwell" }) as HTMLOptionElement;
    expect(option.value).toBe("c1");
  });

  it("accepts raw primitive arrays too", () => {
    render(<Select label="Status" options={["open", "closed"]} />);
    expect(screen.getByRole("option", { name: "open" })).toBeTruthy();
  });

  it("fires onChange with the selected value", () => {
    const onChange = vi.fn();
    render(<Select label="Client" options={clients} labelField="name" valueField="id" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "c2" } });
    expect(onChange).toHaveBeenCalledWith("c2");
  });

  it("hands a multiple select's whole selection over, not its first option", () => {
    const onChange = vi.fn();
    render(<Select label="Clients" multiple options={clients} labelField="name" valueField="id" onChange={onChange} />);
    const box = screen.getByRole("listbox") as HTMLSelectElement;

    for (const option of box.options) option.selected = true;
    fireEvent.change(box);
    expect(onChange).toHaveBeenCalledWith(["c1", "c2"]);
  });

  it("takes an option's OWN disabled key — no prop names it", () => {
    render(
      <Select
        label="Client"
        options={[{ id: "c1", name: "Hartwell" }, { id: "c2", name: "Acme", disabled: true }]}
        labelField="name"
        valueField="id"
      />,
    );
    expect((screen.getByRole("option", { name: "Hartwell" }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole("option", { name: "Acme" }) as HTMLOptionElement).disabled).toBe(true);
  });

  it("files options under their own group, each run where its first member stood", () => {
    const { container } = render(
      <Select
        label="Account"
        options={[
          { id: "a1", name: "Checking", group: "Cash" },
          { id: "b1", name: "Brokerage", group: "Invested" },
          { id: "a2", name: "Savings", group: "Cash" },
        ]}
        labelField="name"
        valueField="id"
      />,
    );
    const groups = [...container.querySelectorAll("optgroup")];

    expect(groups.map((group) => group.label)).toEqual(["Cash", "Invested"]);
    // Not two "Cash" runs: a group is one heading wherever its members were written.
    expect([...groups[0]!.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Checking", "Savings"]);
  });

  it("leaves an ungrouped list exactly as flat as it was", () => {
    const { container } = render(<Select label="Status" options={["open", "closed"]} />);
    expect(container.querySelector("optgroup")).toBeNull();
  });
});

describe("Input / Textarea / Checkbox", () => {
  it("Input fires onChange with the typed value", () => {
    const onChange = vi.fn();
    render(<Input label="Find a client" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Find a client" }), { target: { value: "har" } });
    expect(onChange).toHaveBeenCalledWith("har");
  });

  it("Textarea renders a multiline control", () => {
    render(<Textarea label="Notes" />);
    const el = screen.getByRole("textbox", { name: "Notes" });
    expect(el.tagName).toBe("TEXTAREA");
  });

  it("Checkbox toggles and reports its checked state", () => {
    const onChange = vi.fn();
    render(<Checkbox label="Include paid" onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include paid" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("Checkbox wears the third state, and restates it on every render", () => {
    const box = () => screen.getByRole("checkbox", { name: "Include paid" }) as HTMLInputElement;
    const view = render(<Checkbox label="Include paid" indeterminate />);

    // A DOM property, not an attribute — so the assertion is made on the node.
    expect(box().indeterminate).toBe(true);
    expect(box().checked).toBe(false);

    view.rerender(<Checkbox label="Include paid" indeterminate={false} />);
    expect(box().indeterminate).toBe(false);
  });
});

describe("DatePicker", () => {
  it("renders a date control with a label", () => {
    render(<DatePicker label="Due date" value="2026-03-14" />);
    const el = screen.getByLabelText("Due date") as HTMLInputElement;
    expect(el.type).toBe("date");
    expect(el.value).toBe("2026-03-14");
  });
});

describe("Form", () => {
  it("renders children and fires onSubmit", () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(
      <Form onSubmit={onSubmit} submitLabel="Save">
        <Input label="Name" />
      </Form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  // genqa defect 2: a generated island's onSubmit is often a hydrated
  // `$action` binding (packages/agent/src/tools.ts's runtime hydrate()) —
  // a zero-arg callback that can never call preventDefault itself. Form must
  // own preventDefault unconditionally, or the native submission still fires
  // and the jail's sandbox (deliberately no allow-forms) blocks it with a
  // console error instead of the action ever appearing to resolve.
  it("prevents the native submission even when the caller's onSubmit never calls preventDefault", () => {
    const onSubmit = vi.fn();
    render(
      <Form onSubmit={onSubmit} submitLabel="Save">
        <Input label="Name" />
      </Form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    const event = onSubmit.mock.calls[0]![0] as { defaultPrevented: boolean };
    expect(event.defaultPrevented).toBe(true);
  });

  // Base UI validates the controls that REGISTER with it, and Textarea, Select
  // and Checkbox are still native — so their `required` used to decorate the
  // field and stop nothing at all. Form is where every Kit-composed submit passes
  // through, so it is where the element's own validity is checked.
  describe("the native three's `required`", () => {
    const filled = (onSubmit: () => void) => render(
      <Form onSubmit={onSubmit} submitLabel="Save">
        <Textarea label="Why" required />
        <Select label="Client" options={["Hartwell", "Acme"]} placeholder="Pick one" required />
        <Checkbox label="I agree" required />
      </Form>,
    );
    const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

    it("refuses the submit, and puts the person where the fix is", () => {
      const onSubmit = vi.fn();
      const { container } = filled(onSubmit);

      // The reason the check has to be made in code: the browser will not make it.
      expect((container.querySelector("form") as HTMLFormElement).noValidate).toBe(true);

      save();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByLabelText("Why"));

      // One field at a time, in the order they were written.
      fireEvent.change(screen.getByLabelText("Why"), { target: { value: "because" } });
      save();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByLabelText("Client"));

      fireEvent.change(screen.getByLabelText("Client"), { target: { value: "Acme" } });
      save();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByLabelText("I agree"));
    });

    it("submits once every one of them is answered", () => {
      const onSubmit = vi.fn();
      filled(onSubmit);

      fireEvent.change(screen.getByLabelText("Why"), { target: { value: "because" } });
      fireEvent.change(screen.getByLabelText("Client"), { target: { value: "Acme" } });
      fireEvent.click(screen.getByLabelText("I agree"));

      save();
      expect(onSubmit).toHaveBeenCalledOnce();
    });
  });
});

describe("Disclaimer (first-class)", () => {
  it("renders the reason text prominently", () => {
    render(<Disclaimer reason="No tool exposes payroll data, so this can't be shown." />);
    expect(screen.getByText(/No tool exposes payroll data/)).toBeTruthy();
    expect(screen.getByRole("note")).toBeTruthy();
  });
});
