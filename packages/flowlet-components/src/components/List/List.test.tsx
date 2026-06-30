import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { listDescriptor } from "./descriptor";
import { List } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("List", () => {
  it("schema accepts valid items and rejects empty array", () => {
    expect(listDescriptor.propsSchema.safeParse({ items: [{ title: "Item A" }] }).success).toBe(true);
    expect(listDescriptor.propsSchema.safeParse({ items: [] }).success).toBe(false);
    expect(listDescriptor.propsSchema.safeParse({}).success).toBe(false);
  });

  it("renders item titles", () => {
    renderThemed(
      <List items={[{ title: "Account Overview" }, { title: "Transactions", subtitle: "Last 30 days" }]} />
    );
    expect(screen.getByText("Account Overview")).toBeInTheDocument();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
  });

  it("renders optional subtitles", () => {
    renderThemed(
      <List items={[{ title: "Savings", subtitle: "High yield" }]} />
    );
    expect(screen.getByText("High yield")).toBeInTheDocument();
  });
});
