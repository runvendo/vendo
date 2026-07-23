// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { UIMessage } from "ai";
import { VendoProvider } from "../../src/index.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";

afterEach(cleanup);

/** A data-vendo-view stream part carrying the forming (or finished) payload. */
function viewPart(streaming: boolean): UIMessage["parts"][number] {
  return {
    type: "data-vendo-view",
    data: {
      appId: "app_renewals",
      payload: {
        formatVersion: "vendo-genui/v2",
        name: "Renewals radar",
        root: "root",
        nodes: [
          { id: "root", component: "Stack", children: ["note"] },
          { id: "note", component: "Text", props: { text: "Seven renewals in the next 30 days." } },
        ],
        ...(streaming ? { streaming: true } : {}),
      },
    },
  } as unknown as UIMessage["parts"][number];
}

function renderPart(part: UIMessage["parts"][number], restored = false) {
  return render(
    <VendoProvider>
      <ThreadPart part={part} partKey="p0" role="assistant" restored={restored} risks={new Map()} />
    </VendoProvider>,
  );
}

function partTree(part: UIMessage["parts"][number], restored = false) {
  return (
    <VendoProvider>
      <ThreadPart part={part} partKey="p0" role="assistant" restored={restored} risks={new Map()} />
    </VendoProvider>
  );
}

describe("appcard boot bar (pick C)", () => {
  it("narrates a forming view: building state, label, hairline", () => {
    renderPart(viewPart(true));
    const bar = document.querySelector(".fl-appcard-bar");
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("data-state")).toBe("building");
    expect(bar!.querySelector(".fl-boot-building")?.textContent).toContain("Building your view");
    expect(bar!.querySelector(".fl-boot-hairline")).not.toBeNull();
  });

  it("flips to ready with the app name once the stream completes", () => {
    renderPart(viewPart(false));
    const bar = document.querySelector(".fl-appcard-bar");
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("data-state")).toBe("ready");
    expect(bar!.querySelector(".fl-boot-ready")?.textContent).toBe("Renewals radar");
    // the label pair stays mounted so the swap is a crossfade, not a remount
    expect(bar!.querySelector(".fl-boot-building")).not.toBeNull();
  });

  it("ships the boot + fill rules in the chrome stylesheet", () => {
    expect(CHROME_CSS).toContain(".fl-boot-hairline");
    expect(CHROME_CSS).toContain("fl-boot-sweep");
    expect(CHROME_CSS).toContain(".fl-boot-labels");
    expect(CHROME_CSS).toContain(".fl-reveal-fill");
  });
});

describe("appcard presents from the top (empty-states batch)", () => {
  it("scrolls the card's top into view once when a live build settles", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = renderPart(viewPart(true));
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(partTree(viewPart(false)));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    // Settling is one presentation, not a scroll subscription.
    rerender(partTree(viewPart(false)));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("never scrolls for restored history — the reader owns their position", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPart(viewPart(false), true);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("gives the scrolled card breathing room in the stylesheet", () => {
    expect(CHROME_CSS).toContain("scroll-margin-top");
  });
});
