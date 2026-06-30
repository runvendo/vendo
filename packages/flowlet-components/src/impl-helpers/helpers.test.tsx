import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { z } from "zod";
import { allowlistUrl } from "./safe-url";
import { createPrewiredImpl } from "./create-impl";

describe("allowlistUrl", () => {
  it("passes https and safe data:image types, rejects javascript, data:text/html, and data:image/svg+xml", () => {
    expect(allowlistUrl("https://x.com/a.png")).toBe("https://x.com/a.png");
    expect(allowlistUrl("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
    expect(allowlistUrl("data:image/jpeg;base64,AAA")).toBe("data:image/jpeg;base64,AAA");
    expect(allowlistUrl("data:image/gif;base64,AAA")).toBe("data:image/gif;base64,AAA");
    expect(allowlistUrl("data:image/webp;base64,AAA")).toBe("data:image/webp;base64,AAA");
    // svg+xml can carry inline scripts — must be rejected
    expect(allowlistUrl("data:image/svg+xml;base64,AAA")).toBeUndefined();
    expect(allowlistUrl("javascript:alert(1)")).toBeUndefined();
    expect(allowlistUrl("data:text/html,<script>")).toBeUndefined();
  });
});

describe("createPrewiredImpl", () => {
  const Demo = createPrewiredImpl(z.object({ title: z.string() }), (p) => (
    <div data-testid="ok">{p.title}</div>
  ));

  it("renders on valid props", () => {
    render(<Demo title="hi" />);
    expect(screen.getByTestId("ok").textContent).toBe("hi");
  });

  it("renders a fallback (not a throw) on invalid props", () => {
    render(<Demo title={123 as unknown as string} />);
    expect(screen.getByTestId("flowlet-invalid-props")).toBeInTheDocument();
  });
});
