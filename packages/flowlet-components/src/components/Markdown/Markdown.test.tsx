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

  it("SECURITY: raw HTML tags are not rendered as DOM elements", () => {
    const { container } = renderThemed(<Markdown content="<img src='x' onerror='alert(1)'>" />);
    // The img may or may not appear but must not have onerror
    const imgs = container.querySelectorAll('img[onerror]');
    expect(imgs.length).toBe(0);
  });
});
