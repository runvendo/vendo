// @vitest-environment jsdom
// ENG-388 F12 — launcher placement: all four corners plus host pixel offsets,
// so a host whose own UI owns a corner stops being forced into launcher="none"
// + programmatic control. The offset rides CSS variables folded into the
// safe-area calc; the whisper caption inherits them so the cluster moves as one.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { createWireServer } from "../wire-server.js";

describe("VendoOverlay launcher placement (F12)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  const launcher = () => screen.getByRole("button", { name: "AI agent" });

  it("supports the top corners in string form, with fixed-position CSS to match", () => {
    render(<VendoProvider client={client}><VendoOverlay launcher="top-left" /></VendoProvider>);
    expect(launcher().getAttribute("data-vendo-launcher")).toBe("top-left");
    expect(CHROME_CSS).toContain('.fl-launcher[data-vendo-launcher="top-left"]');
    expect(CHROME_CSS).toContain('.fl-launcher[data-vendo-launcher="top-right"]');
  });

  it("supports a top corner via the object form", () => {
    render(<VendoProvider client={client}><VendoOverlay launcher={{ position: "top-right" }} /></VendoProvider>);
    expect(launcher().getAttribute("data-vendo-launcher")).toBe("top-right");
  });

  it("rides host offsets as CSS variables folded into the corner calc", () => {
    render(
      <VendoProvider client={client}>
        <VendoOverlay launcher={{ position: "bottom-right", offset: { x: 24, y: 12 } }} />
      </VendoProvider>,
    );
    const style = launcher().style;
    expect(style.getPropertyValue("--vendo-launcher-x")).toBe("24px");
    expect(style.getPropertyValue("--vendo-launcher-y")).toBe("12px");
    // The stylesheet actually consumes the variables (default 0px keeps every
    // existing install pixel-identical).
    expect(CHROME_CSS).toContain("var(--vendo-launcher-x, 0px)");
    expect(CHROME_CSS).toContain("var(--vendo-launcher-y, 0px)");
  });

  it("keeps the default untouched: bottom-right, no offset variables", () => {
    render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    expect(launcher().getAttribute("data-vendo-launcher")).toBe("bottom-right");
    expect(launcher().style.getPropertyValue("--vendo-launcher-x")).toBe("");
    expect(launcher().style.getPropertyValue("--vendo-launcher-y")).toBe("");
  });
});
