import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { z } from "zod";
import { allowlistUrl } from "./safe-url";
import { createPrewiredImpl } from "./create-impl";
import { resolveIcon } from "./icon";

describe("allowlistUrl", () => {
  it("passes safe data:image types, rejects https, javascript, data:text/html, and data:image/svg+xml", () => {
    // https is rejected: the sandbox CSP is `img-src data:`, so a remote src would
    // render broken (blocked by CSP) and is also an exfiltration vector.
    expect(allowlistUrl("https://x.com/a.png")).toBeUndefined();
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

  it("error boundary: render-time throw shows the fallback instead of crashing", () => {
    // Suppress React's error boundary console.error output
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const Thrower = createPrewiredImpl(z.object({}), () => {
      throw new Error("boom");
    });
    render(<Thrower />);
    expect(screen.getByTestId("flowlet-invalid-props")).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe("resolveIcon", () => {
  it("resolves a PascalCase icon name", () => {
    const node = resolveIcon("Wallet");
    expect(node).not.toBeNull();
  });

  it("normalizes lowercase to PascalCase", () => {
    const node = resolveIcon("wallet");
    expect(node).not.toBeNull();
  });

  it("normalizes kebab-case to PascalCase", () => {
    const node = resolveIcon("wallet-cards");
    expect(node).not.toBeNull();
  });

  it("rejects createLucideIcon (a utility fn, not a forwardRef icon)", () => {
    const node = resolveIcon("createLucideIcon");
    expect(node).toBeNull();
  });

  it("returns null for unknown icon names", () => {
    expect(resolveIcon("NonExistentIcon12345")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(resolveIcon(42)).toBeNull();
    expect(resolveIcon(null)).toBeNull();
  });
});
