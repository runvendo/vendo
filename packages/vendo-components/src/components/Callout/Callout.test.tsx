import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VendoThemeProvider } from "../../theme/VendoThemeProvider.js";
import { calloutDescriptor } from "./descriptor.js";
import { Callout } from "./impl.js";

const renderThemed = (ui: React.ReactNode) =>
  render(<VendoThemeProvider>{ui}</VendoThemeProvider>);

describe("Callout", () => {
  it("schema accepts valid variants and rejects unknown ones", () => {
    expect(
      calloutDescriptor.propsSchema.safeParse({ variant: "info", text: "Note" }).success,
    ).toBe(true);
    expect(
      calloutDescriptor.propsSchema.safeParse({ variant: "danger", text: "Error" }).success,
    ).toBe(true);
    expect(
      calloutDescriptor.propsSchema.safeParse({ variant: "unknown", text: "Bad" }).success,
    ).toBe(false);
  });

  it("renders the text and optional title", () => {
    renderThemed(<Callout variant="warning" title="Heads up" text="This may cause issues." />);
    expect(screen.getByText("This may cause issues.")).toBeInTheDocument();
    expect(screen.getByText("Heads up")).toBeInTheDocument();
  });
});
