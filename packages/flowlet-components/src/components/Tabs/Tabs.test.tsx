import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { tabsDescriptor } from "./descriptor";
import { Tabs } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("Tabs", () => {
  it("schema accepts valid tabs and rejects empty array", () => {
    expect(
      tabsDescriptor.propsSchema.safeParse({
        tabs: [{ label: "Tab A", content: "Content A" }],
      }).success
    ).toBe(true);
    expect(tabsDescriptor.propsSchema.safeParse({ tabs: [] }).success).toBe(false);
    expect(tabsDescriptor.propsSchema.safeParse({}).success).toBe(false);
  });

  it("renders the first tab's label", () => {
    renderThemed(
      <Tabs
        tabs={[
          { label: "Overview", content: "Overview content" },
          { label: "Details", content: "Details content" },
        ]}
      />
    );
    expect(screen.getByText("Overview")).toBeInTheDocument();
  });

  it("renders the first tab's content (default active tab)", () => {
    renderThemed(
      <Tabs
        tabs={[
          { label: "Summary", content: "This is the summary" },
          { label: "History", content: "This is the history" },
        ]}
      />
    );
    expect(screen.getByText("This is the summary")).toBeInTheDocument();
  });

  it("renders all tab labels", () => {
    renderThemed(
      <Tabs
        tabs={[
          { label: "Alpha", content: "A content" },
          { label: "Beta", content: "B content" },
          { label: "Gamma", content: "G content" },
        ]}
      />
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });
});
