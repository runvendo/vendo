import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VendoThemeProvider } from "../../theme/VendoThemeProvider";
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
      <VendoThemeProvider>
        <Form submitLabel="Save" fields={[{ type: "text", name: "name", label: "Full name" }]} />
      </VendoThemeProvider>,
    );
    expect(screen.getByText("Full name")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Save" });
    expect(submit).toBeDisabled();
  });

  it("renders options for select/radio fields", () => {
    render(
      <VendoThemeProvider>
        <Form submitLabel="Go" fields={[
          { type: "select", name: "plan", label: "Plan", options: [{ value: "pro", label: "Pro Plan" }, { value: "free", label: "Free Plan" }] },
        ]} />
      </VendoThemeProvider>,
    );
    expect(screen.getByText("Pro Plan")).toBeInTheDocument();
    expect(screen.getByText("Free Plan")).toBeInTheDocument();
  });

  it("text input has id matching field name for label association", () => {
    const { container } = render(
      <VendoThemeProvider>
        <Form submitLabel="Save" fields={[{ type: "text", name: "email", label: "Email" }]} />
      </VendoThemeProvider>,
    );
    const input = container.querySelector('input[name="email"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute("id")).toBe("email");
  });

  it("select field is NOT disabled (form is inert via submit, not via disabled)", () => {
    const { container } = render(
      <VendoThemeProvider>
        <Form submitLabel="Go" fields={[
          { type: "select", name: "plan", label: "Plan", options: [{ value: "a", label: "A" }] },
        ]} />
      </VendoThemeProvider>,
    );
    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(false);
  });
});
