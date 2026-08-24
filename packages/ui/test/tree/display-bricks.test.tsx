// @vitest-environment jsdom
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DISPLAY_TAG_NAMES, flattenTree } from "@vendoai/apps/contract";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { PayloadView, TreeView, type WalkTree } from "../../src/tree/index.js";
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

  it("paints the host's own class on a PORTED node, and on no other", () => {
    // The two sections are identical but for `source`. Only the ported one was
    // painted from real host source, so only its class survives to the DOM —
    // the class the model wrote on the other is dropped at the brick, as ever.
    // This is the RENDERER's own gate and nothing more — the seam test below is
    // what proves a real paint's class survives the format gate to get here.
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "div", children: ["port", "wrote"] },
          { id: "port", component: "section", source: "ported", props: { className: "maple-card" }, children: ["a"] },
          { id: "a", component: "#text", props: { text: "Ported" } },
          { id: "wrote", component: "section", props: { className: "maple-card" }, children: ["b"] },
          { id: "b", component: "#text", props: { text: "Written" } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Ported").closest("section")!.getAttribute("class")).toBe("maple-card");
    expect(screen.getByText("Written").closest("section")!.getAttribute("class")).toBeNull();
  });

  it("paints the host's class on a PORTED Kit Button — the <button> rewrite target — and on no other", () => {
    // The splitter rewrites a host <button className style onClick> to the Kit
    // Button, and the host's CSS must keep styling it: the class survives on
    // the ported node exactly as it does on a brick, and on no other source.
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "div", children: ["port", "wrote"] },
          { id: "port", component: "Button", source: "ported", props: { className: "range-chip" }, children: ["a"] },
          { id: "a", component: "#text", props: { text: "1W" } },
          { id: "wrote", component: "Button", props: { label: "1M", className: "range-chip" } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByText("1W").closest("button")!.getAttribute("class")).toBe("range-chip");
    expect(screen.getByText("1M").closest("button")!.getAttribute("class")).toBeNull();
  });

  /**
   * THE SEAM. Three parties, none of them stubbed: the real producer flattens a
   * paint and stamps it (`flattenTree`, apps genui/component/flatten.ts), the
   * real format gate validates it (`validateTree` via convert-payload.ts), and
   * the renderer paints it. The tests above enter through `TreeView`, which takes
   * a walk tree directly and so never meets the format gate — they prove the
   * renderer's own rule and nothing about whether a port survives the wire.
   *
   * This one is why the feature shipped dead once already: the gate refused
   * `"ported"` while the renderer honored it, and no test crossed the fence.
   */
  it("carries the host's class from the paint, through the format gate, onto the DOM", () => {
    const flat = flattenTree(
      { component: "section", props: { className: "maple-card" }, children: ["Ported"] },
      "ported",
    );

    render(
      <PayloadView
        payload={{ formatVersion: VENDO_TREE_FORMAT, root: flat.root, nodes: Object.values(flat.nodes) } as never}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Ported").closest("section")!.getAttribute("class")).toBe("maple-card");
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
    // The wire is Json, so a node can carry `"style": null` — and the door reads
    // every node's style now, not just a brick's.
    expect(safeStyle(null)).toBeUndefined();
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

  it("filters a Kit component's style through the same allowlist", () => {
    // A Kit root MERGES the model's `style` onto its own, so an unfiltered one
    // smuggles through `Card` exactly what a `<div>` may not paint.
    render(
      <TreeView
        tree={tree([{
          id: "root",
          component: "Card",
          props: { title: "Spending", style: { padding: "8px", backgroundImage: "url(https://evil/x)", filter: "blur(4px)" } },
        }])}
        components={{}}
        onAction={ok}
      />,
    );

    const card = document.querySelector<HTMLElement>('[data-kit="Card"]')!;
    expect(card.style.padding).toBe("8px");
    expect(card.style.backgroundImage).toBe("");
    expect(card.style.filter).toBe("");
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
