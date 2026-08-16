// @vitest-environment jsdom
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DISPLAY_TAG_NAMES } from "@vendoai/apps/contract";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";
import { DISPLAY_BRICKS, SURFACE_CONTAINMENT, safeStyle } from "../../src/tree/display-bricks.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const tree = (nodes: WalkTree["nodes"]): WalkTree & { formatVersion: typeof VENDO_TREE_FORMAT } =>
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

  it("keeps an allowlisted property whatever its value — no value is inspected", () => {
    // A themed fill rides `backgroundColor` (a color cannot fetch); the value is
    // passed straight through, never parsed.
    expect(safeStyle({
      padding: "8px",
      color: "var(--vendo-color-accent)",
      backgroundColor: "var(--vendo-surface)",
      transform: "translateX(4px)",
    })).toEqual({
      padding: "8px",
      color: "var(--vendo-color-accent)",
      backgroundColor: "var(--vendo-surface)",
      transform: "translateX(4px)",
    });
    expect(safeStyle(undefined)).toBeUndefined();
  });

  it("drops the fetch-capable properties whatever their value", () => {
    // These carry `url()`/`image-set()`, so they are off the allowlist and drop
    // wholesale — even a plain gradient or blur, which are no longer available to
    // a raw brick. Nothing reads the value; there is no spelling to bypass.
    expect(safeStyle({ background: "linear-gradient(red, blue)" })).toEqual({});
    expect(safeStyle({ background: "url(https://evil/x)" })).toEqual({});
    expect(safeStyle({ backgroundImage: "linear-gradient(red, blue)" })).toEqual({});
    expect(safeStyle({ filter: "blur(4px)" })).toEqual({});
    expect(safeStyle({ backdropFilter: "blur(4px)" })).toEqual({});
    expect(safeStyle({ cursor: "pointer" })).toEqual({});
  });

  it("drops every property the allowlist does not name", () => {
    expect(safeStyle({
      WebkitMaskImage: "url(https://evil/x)",
      content: "url(https://evil/y)",
      color: "red",
    } as CSSProperties)).toEqual({ color: "red" });
  });

  it("allows position and leans on the surface box to contain it", () => {
    // Option (b): no value check on `position`. `SURFACE_CONTAINMENT` clips even
    // fixed/sticky to the box (see "paints the surface inside its own box"), so
    // the value passes through and the box, not a string scan, holds it in.
    expect(safeStyle({ position: "fixed" })).toEqual({ position: "fixed" });
    expect(safeStyle({ position: "relative" })).toEqual({ position: "relative" });
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
