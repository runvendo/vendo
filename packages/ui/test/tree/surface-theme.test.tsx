// @vitest-environment jsdom
// A surface is themed by where its PROVIDER is, not by where its DOM is. The
// display bricks are told to paint off `var(--vendo-color-accent)`, and a host
// may mount a bare AppFrame anywhere on its page — demo-bank's Apps workspace
// does, outside every ChromeRoot. Every `--vendo-*` resolved to the empty
// string there, and the bricks fell back to the porcelain defaults their own
// `var(…, fallback)` carries, which is why a screenshot could not see it.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT } from "@vendoai/apps/contract";
import type { ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { ChromeRoot } from "../../src/chrome/chrome-root.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** Nothing in the default theme and no brick fallback is this color. */
const HOST_ACCENT = "#ff00aa";

const tree: WalkTree = {
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [
    { id: "root", component: "h2", props: { style: { color: "var(--vendo-color-accent)" } }, children: ["t"] },
    { id: "t", component: "#text", props: { text: "Overdue" } },
  ],
};

/** What `var(--vendo-color-accent)` on this element resolves to: the nearest
 *  ancestor that declares it, which is what the custom-property cascade does.
 *  Read off the DOM rather than getComputedStyle — jsdom does not inherit
 *  custom properties, so a computed read would answer "" for any depth. */
function resolvedAccent(from: HTMLElement): string {
  for (let el: HTMLElement | null = from; el !== null; el = el.parentElement) {
    const declared = el.style.getPropertyValue("--vendo-color-accent");
    if (declared !== "") return declared;
  }
  return "";
}

describe("surface theming does not depend on DOM ancestry", () => {
  it("resolves the host theme on a surface mounted OUTSIDE ChromeRoot", () => {
    render(
      <VendoProvider client={createVendoClient({ baseUrl: "http://vendo.test/api/vendo" })} theme={{ colors: { accent: HOST_ACCENT } }}>
        <TreeView tree={tree} components={{}} onAction={ok} />
      </VendoProvider>,
    );

    expect(document.querySelector(".vendo-root")).toBeNull();
    expect(resolvedAccent(screen.getByText("Overdue"))).toBe(HOST_ACCENT);
  });

  it("resolves the same value inside ChromeRoot — one mapping, nothing to disagree about", () => {
    render(
      <VendoProvider client={createVendoClient({ baseUrl: "http://vendo.test/api/vendo" })} theme={{ colors: { accent: HOST_ACCENT } }}>
        <ChromeRoot>
          <TreeView tree={tree} components={{}} onAction={ok} />
        </ChromeRoot>
      </VendoProvider>,
    );

    expect(document.querySelector(".vendo-root")).not.toBeNull();
    expect(resolvedAccent(screen.getByText("Overdue"))).toBe(HOST_ACCENT);
  });
});
