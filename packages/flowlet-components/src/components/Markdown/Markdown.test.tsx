import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { markdownDescriptor } from "./descriptor";
import { Markdown } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("Markdown", () => {
  it("schema accepts a content string and rejects missing content", () => {
    expect(markdownDescriptor.propsSchema.safeParse({ content: "# Hello" }).success).toBe(true);
    expect(markdownDescriptor.propsSchema.safeParse({}).success).toBe(false);
  });

  it("renders bold markdown as <strong>", () => {
    const { container } = renderThemed(<Markdown content="**bold text**" />);
    expect(container.querySelector("strong")).not.toBeNull();
    expect(screen.getByText("bold text")).toBeInTheDocument();
  });

  it("renders headings from markdown", () => {
    const { container } = renderThemed(<Markdown content="# Title" />);
    expect(container.querySelector("h1")).not.toBeNull();
  });

  it("SECURITY: raw <script> input does NOT produce a <script> element", () => {
    const { container } = renderThemed(<Markdown content="<script>alert(1)</script>" />);
    expect(container.querySelector("script")).toBeNull();
  });

  it("SECURITY: raw HTML tags are escaped as text, not rendered as DOM elements", () => {
    const { container } = renderThemed(<Markdown content="<b>x</b><img src='x' onerror='alert(1)'>" />);
    // Must not produce real <b> or <img onerror> — raw HTML is escaped to text
    expect(container.querySelectorAll('img[onerror]').length).toBe(0);
    // The literal string "<b>" should appear as text, not as a <b> element
    expect(container.querySelector("b")).toBeNull();
  });

  it("SECURITY URL: javascript: links are dropped", () => {
    const { container } = renderThemed(<Markdown content="[click](javascript:alert(1))" />);
    const a = container.querySelector("a");
    if (a) {
      expect(a.getAttribute("href")).not.toMatch(/^javascript:/i);
    }
  });

  it("SECURITY URL: http: links are dropped (only https allowed)", () => {
    const { container } = renderThemed(<Markdown content="[click](http://evil.test)" />);
    const a = container.querySelector("a");
    if (a) {
      const href = a.getAttribute("href") ?? "";
      expect(href).not.toMatch(/^http:/i);
    }
  });

  it("URL POLICY: https links are preserved", () => {
    const { container } = renderThemed(<Markdown content="[visit](https://ok.test)" />);
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://ok.test");
  });

  it("URL POLICY: http images are dropped/neutralized", () => {
    const { container } = renderThemed(<Markdown content="![alt](http://evil.test/a.png)" />);
    const img = container.querySelector("img");
    if (img) {
      const src = img.getAttribute("src") ?? "";
      expect(src).not.toMatch(/^http:/i);
    }
  });

  it("URL POLICY: https images are rendered", () => {
    const { container } = renderThemed(<Markdown content="![alt](https://ok.test/a.png)" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://ok.test/a.png");
  });
});
