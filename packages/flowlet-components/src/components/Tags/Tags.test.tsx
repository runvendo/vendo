import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { tagsDescriptor } from "./descriptor";
import { Tags } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("Tags", () => {
  it("schema accepts valid tags and rejects empty items array", () => {
    expect(
      tagsDescriptor.propsSchema.safeParse({ items: [{ text: "React" }] }).success,
    ).toBe(true);
    expect(tagsDescriptor.propsSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it("renders each tag text", () => {
    renderThemed(<Tags items={[{ text: "frontend" }, { text: "typescript" }]} />);
    expect(screen.getByText("frontend")).toBeInTheDocument();
    expect(screen.getByText("typescript")).toBeInTheDocument();
  });
});
