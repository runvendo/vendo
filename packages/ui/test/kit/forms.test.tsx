// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});

describe("Disclaimer (first-class)", () => {
  it("renders the reason text prominently", () => {
    render(<Disclaimer reason="No tool exposes payroll data, so this can't be shown." />);
    expect(screen.getByText(/No tool exposes payroll data/)).toBeTruthy();
    expect(screen.getByRole("note")).toBeTruthy();
  });
});
