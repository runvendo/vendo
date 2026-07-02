import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { imageGalleryDescriptor } from "./descriptor";
import { ImageGallery } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("ImageGallery", () => {
  it("schema accepts valid images and rejects empty array", () => {
    expect(
      imageGalleryDescriptor.propsSchema.safeParse({
        images: [{ src: "https://example.com/a.jpg", alt: "A" }],
      }).success
    ).toBe(true);
    expect(imageGalleryDescriptor.propsSchema.safeParse({ images: [] }).success).toBe(false);
    expect(imageGalleryDescriptor.propsSchema.safeParse({}).success).toBe(false);
  });

  it("renders valid data:image images", () => {
    const { container } = renderThemed(
      <ImageGallery
        images={[
          { src: "data:image/png;base64,AAA", alt: "Photo A" },
          { src: "data:image/jpeg;base64,AAA", alt: "Photo B" },
        ]}
      />
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBeGreaterThanOrEqual(2);
  });

  it("SECURITY: drops javascript: and https srcs — only safe data:image renders", () => {
    // https is blocked to match the sandbox CSP (`img-src data:`); only data:image renders.
    const { container } = renderThemed(
      <ImageGallery
        images={[
          { src: "javascript:alert(1)", alt: "evil" },
          { src: "https://example.com/remote.jpg", alt: "remote" },
          { src: "data:image/png;base64,AAA", alt: "safe" },
        ]}
      />
    );
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull();
    expect(container.querySelector('img[src^="https:"]')).toBeNull();
    // the safe data:image should still render
    expect(container.querySelector('img[src^="data:image"]')).not.toBeNull();
  });

  it("SECURITY: drops all images when all srcs are invalid", () => {
    const { container } = renderThemed(
      <ImageGallery
        images={[
          { src: "javascript:alert(1)", alt: "evil1" },
          { src: "data:text/html,bad", alt: "evil2" },
        ]}
      />
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
