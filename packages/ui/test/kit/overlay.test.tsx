// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../../src/kit/overlay/modal.js";
import { Sheet } from "../../src/kit/overlay/sheet.js";
import { KIT_CSS, ensureKitStyles } from "../../src/kit/kit-css.js";

describe("the overlay host", () => {
  it("paints OUTSIDE the containment box it was written in", () => {
    // The whole point of the portal: written inside a clipped, transformed
    // column, the dialog still lands on <body> where nothing can crop it.
    const { container } = render(
      <div style={{ overflow: "hidden", transform: "translateZ(0)", height: 20 }}>
        <Modal open title="Send reminders?">
          <p>three clients</p>
        </Modal>
      </div>,
    );
    const popup = screen.getByText("three clients");
    expect(container.contains(popup)).toBe(false);
    expect(document.body.contains(popup)).toBe(true);
    expect(popup.closest(".vendo-root")).toBeTruthy();
    expect(popup.closest("[data-vendo-portal='kit-overlay']")).toBeTruthy();
  });

  it("carries onClose THROUGH the portal — the React tree is unbroken", () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Send reminders?" />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    render(<Modal title="Send reminders?"><p>three clients</p></Modal>);
    expect(screen.queryByText("three clients")).toBeNull();
  });

  it("puts a Sheet on the edge it was asked for, and a Modal in the middle", () => {
    render(<Sheet open side="left" title="Detail" />);
    const sheet = document.querySelector("[data-kit='Sheet']") as HTMLElement;
    expect(sheet.style.left).toBe("0px");
    expect(sheet.style.transform).toBe("");
    render(<Modal open title="Detail" />);
    const modal = document.querySelector("[data-kit='Modal']") as HTMLElement;
    expect(modal.style.transform).toBe("translate(-50%, -50%)");
  });

  it("renders the title and description as the dialog's own labels", () => {
    render(<Modal open title="Send reminders?" description="Three clients will be emailed." />);
    expect(screen.getByText("Send reminders?")).toBeTruthy();
    expect(screen.getByText("Three clients will be emailed.")).toBeTruthy();
  });

  it("takes header and footer slots", () => {
    render(<Modal open title="T" header={<span>badge</span>} footer={<button>Send</button>} />);
    expect(screen.getByText("badge")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});

describe("the Kit stylesheet", () => {
  it("injects once and is idempotent", () => {
    ensureKitStyles();
    ensureKitStyles();
    ensureKitStyles();
    expect(document.querySelectorAll("style[data-vendo-kit]").length).toBe(1);
    expect(document.querySelector("style[data-vendo-kit]")?.textContent).toBe(KIT_CSS);
  });

  it("carries pseudo-class STATE only, and no color it did not read off a token", () => {
    for (const rule of KIT_CSS.split("\n")) {
      const selector = rule.slice(0, rule.indexOf("{"));
      expect(selector, rule).toMatch(/:(hover|focus-visible|active)\b/);
    }
    // Every color resolves to a --vendo-* variable; a literal is a brand leak.
    const declarations = KIT_CSS.match(/(background|color|border-color|outline):[^;]+/gu) ?? [];
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) expect(declaration, declaration).toContain("var(--vendo-");
  });

  it("stands down the press movement under reduced motion", () => {
    expect(KIT_CSS).toContain('[data-vendo-motion="reduced"] [data-kit="Button"]:active { transform: none; }');
  });
});
