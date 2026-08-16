// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { ChromeRoot } from "../../src/chrome/index.js";
import { VendoProvider } from "../../src/context.js";
import { TreeView } from "../../src/tree/index.js";

/**
 * Generated code mounts natively in the host page now (`InClientMount`), so the
 * document the chrome injects into IS the document a generated screen renders
 * in. That makes this the whole delivery path for a host's brand faces — there
 * is no second venue to hand them to.
 */

const FONTS_CSS = "@font-face { font-family: 'Inter'; font-style: normal; "
  + "src: url(data:font/woff2;base64,d09GMg==) format('woff2'); }";

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("style[data-vendo-fonts],style[data-vendo-chrome]")
    .forEach((style) => style.remove());
});

const generatedTree: UIPayload = {
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [
    { id: "root", component: "Stack", children: ["widget"] },
    { id: "widget", component: "Widget", source: "generated" },
  ],
};

function fontStyles(): HTMLStyleElement[] {
  return [...document.head.querySelectorAll<HTMLStyleElement>("style[data-vendo-fonts]")];
}

describe("the host's brand faces reach the document generated UI renders in", () => {
  it("injects the sheet once, in the same document the generated screen mounts into", async () => {
    const { container } = render(
      <VendoProvider fonts={FONTS_CSS}>
        <ChromeRoot>
          <TreeView tree={generatedTree} components={{}} onAction={ok} />
        </ChromeRoot>
      </VendoProvider>,
    );

    await waitFor(() => expect(fontStyles()).toHaveLength(1));
    expect(fontStyles()[0]!.textContent).toBe(FONTS_CSS);
    // The whole reason head injection suffices: the generated tree renders in
    // the SAME document the sheet went into, and there is no iframe left to
    // hand the faces to separately.
    expect(container.querySelector(".vendo-root")).not.toBeNull();
    expect(fontStyles()[0]!.ownerDocument).toBe(container.ownerDocument);
    expect(container.ownerDocument.querySelector("iframe")).toBeNull();
  });

  it("keeps the faces on their own tag, separate from the chrome sheet", async () => {
    render(
      <VendoProvider fonts={FONTS_CSS}>
        <ChromeRoot><span>brand</span></ChromeRoot>
      </VendoProvider>,
    );

    await waitFor(() => expect(fontStyles()).toHaveLength(1));
    // A surface may want the faces WITHOUT the chrome (it renders inside
    // someone else's client and must keep that client's look), so the two are
    // never one sheet.
    expect(fontStyles()[0]!.textContent).not.toContain(".vendo-root");
    expect(document.head.querySelector("style[data-vendo-chrome]")).not.toBeNull();
  });

  it("adds no tag when the host supplies no sheet", async () => {
    render(
      <VendoProvider>
        <ChromeRoot><span>brand</span></ChromeRoot>
      </VendoProvider>,
    );

    await waitFor(() => expect(document.head.querySelector("style[data-vendo-chrome]")).not.toBeNull());
    expect(fontStyles()).toHaveLength(0);
  });
});

describe("a second provider in the same document", () => {
  it("replaces the sheet rather than being outranked by whoever mounted first", async () => {
    const FIRST = "@font-face { font-family: 'First'; src: url(data:font/woff2;base64,Zg==) format('woff2'); }";
    const SECOND = "@font-face { font-family: 'Second'; src: url(data:font/woff2;base64,Zw==) format('woff2'); }";

    const first = render(
      <VendoProvider fonts={FIRST}>
        <ChromeRoot><span>one</span></ChromeRoot>
      </VendoProvider>,
    );
    await waitFor(() => expect(fontStyles()).toHaveLength(1));
    expect(fontStyles()[0]!.textContent).toBe(FIRST);
    first.unmount();

    render(
      <VendoProvider fonts={SECOND}>
        <ChromeRoot><span>two</span></ChromeRoot>
      </VendoProvider>,
    );

    // One document holds ONE brand sheet, and it is the current one — a stale
    // tag left by an earlier mount must not pin the page to the old faces.
    await waitFor(() => expect(fontStyles()[0]!.textContent).toBe(SECOND));
    expect(fontStyles()).toHaveLength(1);
  });

  it("updates in place when the host swaps the fonts prop on a live provider", async () => {
    const A = "@font-face { font-family: 'A'; src: url(data:font/woff2;base64,YQ==) format('woff2'); }";
    const B = "@font-face { font-family: 'B'; src: url(data:font/woff2;base64,Yg==) format('woff2'); }";

    const view = render(
      <VendoProvider fonts={A}><ChromeRoot><span>x</span></ChromeRoot></VendoProvider>,
    );
    await waitFor(() => expect(fontStyles()[0]!.textContent).toBe(A));

    view.rerender(
      <VendoProvider fonts={B}><ChromeRoot><span>x</span></ChromeRoot></VendoProvider>,
    );
    await waitFor(() => expect(fontStyles()[0]!.textContent).toBe(B));
    expect(fontStyles()).toHaveLength(1);
  });
});
