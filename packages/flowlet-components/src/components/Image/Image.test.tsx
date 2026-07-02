import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { imageDescriptor } from "./descriptor";
import { Image } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("Image", () => {
  it("schema accepts valid props and rejects missing src", () => {
    expect(imageDescriptor.propsSchema.safeParse({ src: "https://example.com/img.png" }).success).toBe(true);
    expect(imageDescriptor.propsSchema.safeParse({ src: "https://example.com/img.png", alt: "test", caption: "My caption" }).success).toBe(true);
    expect(imageDescriptor.propsSchema.safeParse({}).success).toBe(false);
  });

  it("renders an image with alt text for a valid data:image src", () => {
    renderThemed(<Image src="data:image/png;base64,AAA" alt="A photo" />);
    const img = screen.getByRole("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("alt", "A photo");
  });

  it("renders optional caption", () => {
    renderThemed(<Image src="data:image/png;base64,AAA" caption="My caption" />);
    expect(screen.getByText("My caption")).toBeInTheDocument();
  });

  it("SECURITY: blocks https src (sandbox CSP is img-src data:) and renders the blocked fallback", () => {
    const { container } = renderThemed(
      <Image src="https://example.com/photo.jpg" alt="remote" />
    );
    expect(screen.getByTestId("flowlet-blocked-image")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("SECURITY: blocks javascript: src and renders the blocked fallback instead", () => {
    const { container } = renderThemed(
      <Image src="javascript:alert(1)" alt="evil" />
    );
    expect(screen.getByTestId("flowlet-blocked-image")).toBeInTheDocument();
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull();
  });

  it("SECURITY: blocks data: non-image src", () => {
    const { container } = renderThemed(
      <Image src="data:text/html,<script>alert(1)</script>" alt="evil" />
    );
    expect(screen.getByTestId("flowlet-blocked-image")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
