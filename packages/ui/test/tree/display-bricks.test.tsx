// @vitest-environment jsdom
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DISPLAY_TAG_NAMES, VENDO_TREE_FORMAT } from "@vendoai/apps/contract";
import type { ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";
import { DISPLAY_BRICKS, SURFACE_CONTAINMENT, safeStyle } from "../../src/tree/display-bricks.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const tree = (nodes: WalkTree["nodes"]): WalkTree =>
  ({ formatVersion: VENDO_TREE_FORMAT, root: nodes[0]!.id, nodes });

describe("display bricks", () => {
  it("implements exactly the tags the specs name (the drift test)", () => {
    expect(Object.keys(DISPLAY_BRICKS).sort()).toEqual([...DISPLAY_TAG_NAMES].sort());
  });

  it("renders a brick with its style, and nothing else it was handed", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "section", props: { style: { padding: "8px" }, className: "host-chrome", onClick: "x" }, children: ["h"] },
          { id: "h", component: "h2", props: { style: { color: "var(--vendo-color-accent)" } }, children: ["t"] },
          { id: "t", component: "#text", props: { text: "Overdue" } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    const heading = screen.getByText("Overdue");
    expect(heading.tagName).toBe("H2");
    expect(heading.getAttribute("style")).toBe("color: var(--vendo-color-accent);");
    const box = heading.closest("section")!;
    expect(box.getAttribute("style")).toBe("padding: 8px;");
    expect(box.getAttribute("class")).toBeNull();
  });

  it("keeps the allowlisted properties, whatever inert value they hold", () => {
    expect(safeStyle({
      padding: "8px",
      color: "var(--vendo-color-accent)",
      background: "linear-gradient(90deg, red, blue)",
      transform: "translateX(4px)",
    })).toEqual({
      padding: "8px",
      color: "var(--vendo-color-accent)",
      background: "linear-gradient(90deg, red, blue)",
      transform: "translateX(4px)",
    });
    expect(safeStyle(undefined)).toBeUndefined();
  });

  it("drops every property the allowlist does not name", () => {
    expect(safeStyle({
      WebkitMaskImage: "url(https://evil/x)",
      content: "url(https://evil/y)",
      position: "fixed",
      color: "red",
    } as CSSProperties)).toEqual({ color: "red" });
    // `position` keeps only its in-flow values.
    expect(safeStyle({ position: "relative" })).toEqual({ position: "relative" });
  });

  it("keeps a dual-use property's inert value and drops its fetching one", () => {
    expect(safeStyle({ background: "url(https://evil/x)" })).toEqual({});
    expect(safeStyle({ background: "linear-gradient(red, blue)" }))
      .toEqual({ background: "linear-gradient(red, blue)" });
    expect(safeStyle({ filter: "blur(4px)" })).toEqual({ filter: "blur(4px)" });
    expect(safeStyle({ filter: "url(#x)" })).toEqual({});
    // `image-set()` and a `url()` cursor go the same way — a fetch is a fetch.
    expect(safeStyle({ backgroundImage: "image-set('https://evil/y' 1x)" })).toEqual({});
    expect(safeStyle({ cursor: "url(https://evil/z), auto" })).toEqual({});
    expect(safeStyle({ cursor: "pointer" })).toEqual({ cursor: "pointer" });
  });

  it("drops a fetch however its escapes spell the function", () => {
    // The CSS tokenizer unescapes before it decides what a token is, so each of
    // these IS `url(` to the browser whatever the raw string reads.
    expect(safeStyle({ background: "\\75 rl(https://evil/x)" })).toEqual({});
    expect(safeStyle({ background: "u\\72 l(https://evil/y)" })).toEqual({});
    // A custom property is not on the allowlist, so a `var()` that would smuggle
    // one in has nothing to resolve to — both declarations go.
    expect(safeStyle({ "--x": "url(/pixel)", background: "var(--x)" } as CSSProperties)).toEqual({});
  });

  it("paints the surface inside its own box", () => {
    render(
      <TreeView
        tree={tree([{ id: "root", component: "div", props: { style: { position: "fixed", width: "200vw" } } }])}
        components={{}}
        onAction={ok}
      />,
    );

    // Not a rule about the word "fixed": `contain: paint` makes the wrapper the
    // containing block for every fixed descendant, so the escape has nowhere to go.
    // Read declaration by declaration, not as the whole style attribute: the
    // surface is also the theme boundary (surface-theme.test.tsx), so the host's
    // `--vendo-*` sit on this same element.
    const surface = document.querySelector<HTMLElement>("[data-vendo-surface]")!;
    expect(surface.style.contain).toBe("layout paint");
    expect(surface.style.overflow).toBe("clip");
    expect(surface.style.position).toBe("relative");
    expect(surface.style.isolation).toBe("isolate");
    expect(SURFACE_CONTAINMENT.contain).toBe("layout paint");
  });
});
