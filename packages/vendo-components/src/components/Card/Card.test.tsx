import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VendoThemeProvider } from "../../theme/VendoThemeProvider.js";
import { cardDescriptor } from "./descriptor.js";
import { Card } from "./impl.js";

const renderThemed = (ui: React.ReactNode) =>
  render(<VendoThemeProvider>{ui}</VendoThemeProvider>);

describe("Card", () => {
  it("schema accepts a valid card and rejects a missing title", () => {
    expect(cardDescriptor.propsSchema.safeParse({ title: "Hi" }).success).toBe(true);
    expect(cardDescriptor.propsSchema.safeParse({}).success).toBe(false);
  });

  it("renders title, body and tags", () => {
    renderThemed(<Card title="Account" body="Balance is healthy" tags={["active", "verified"]} />);
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Balance is healthy")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });
});
