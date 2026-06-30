import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { cardDescriptor } from "./descriptor";
import { Card } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

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
