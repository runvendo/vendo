import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HttpOpenCard } from "../src/tree/mcp-shim/http-open-card.js";

describe("MCP Apps HTTP open card", () => {
  it("renders a branded, themeable, safe link-out card", () => {
    render(<HttpOpenCard open={{
      kind: "vendo/open-in-product@1",
      url: "https://apps.example/revenue",
      appName: "Revenue dashboard",
      productName: "Maple",
    }} />);

    expect(screen.getByRole("heading", { name: "Revenue dashboard" })).toBeTruthy();
    expect(screen.getByText("Open in Maple")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Revenue dashboard" });
    expect(link.getAttribute("href")).toBe("https://apps.example/revenue");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("style")).toContain("--vendo-color-accent-text");

    const card = screen.getByRole("region", { name: "Open Revenue dashboard in Maple" });
    const style = card.getAttribute("style") ?? "";
    expect(style).toContain("--vendo-color-surface");
    expect(style).toContain("--vendo-color-border");
    expect(style).toContain("--vendo-radius-medium");
  });
});
