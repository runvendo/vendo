import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { formDescriptor } from "./descriptor";
import { Form } from "./impl";

describe("Form", () => {
  it("schema accepts a multi-field form, rejects an unknown field type", () => {
    const ok = { submitLabel: "Save", fields: [
      { type: "text", name: "name", label: "Name" },
      { type: "select", name: "plan", label: "Plan", options: [{ value: "a", label: "A" }] },
    ]};
    expect(formDescriptor.propsSchema.safeParse(ok).success).toBe(true);
    expect(formDescriptor.propsSchema.safeParse({ submitLabel: "x", fields: [{ type: "wormhole", name: "n", label: "L" }] }).success).toBe(false);
  });

  it("renders field labels and a disabled submit (inert in F4)", () => {
    render(
      <FlowletThemeProvider>
        <Form submitLabel="Save" fields={[{ type: "text", name: "name", label: "Full name" }]} />
      </FlowletThemeProvider>,
    );
    expect(screen.getByText("Full name")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Save" });
    expect(submit).toBeDisabled();
  });
});
