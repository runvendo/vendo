import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { accordionDescriptor } from "./descriptor";
import { Accordion } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("Accordion", () => {
  it("schema accepts a valid accordion and rejects empty items array", () => {
    expect(
      accordionDescriptor.propsSchema.safeParse({ items: [{ title: "Q", content: "A" }] }).success,
    ).toBe(true);
    expect(accordionDescriptor.propsSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it("renders item title and content text", () => {
    const { container } = renderThemed(
      <Accordion items={[{ title: "FAQ 1", content: "Answer one" }]} />,
    );
    expect(screen.getByText("FAQ 1")).toBeInTheDocument();
    expect(container.textContent).toContain("Answer one");
  });
});
