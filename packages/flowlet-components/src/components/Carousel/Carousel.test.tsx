import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { carouselDescriptor } from "./descriptor";
import { Carousel } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("Carousel", () => {
  it("schema accepts a valid carousel and rejects empty items array", () => {
    expect(
      carouselDescriptor.propsSchema.safeParse({ items: [{ title: "Slide 1" }] }).success,
    ).toBe(true);
    expect(carouselDescriptor.propsSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it("renders a slide title", () => {
    renderThemed(
      <Carousel items={[{ title: "Featured offer", body: "Limited time deal" }]} />,
    );
    expect(screen.getByText("Featured offer")).toBeInTheDocument();
  });

  it("does not render an img if imageUrl is unsafe", () => {
    const { container } = renderThemed(
      <Carousel items={[{ title: "Slide", imageUrl: "javascript:alert(1)" }]} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
