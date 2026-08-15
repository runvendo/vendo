// @vitest-environment jsdom
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DISPLAY_TAG_NAMES, VENDO_TREE_FORMAT } from "@vendoai/apps/contract";
import type { ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";
import { DISPLAY_BRICKS, SURFACE_CONTAINMENT, withoutFetchableUrls } from "../../src/tree/display-bricks.js";

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

  it("drops the style values that would make the browser fetch", () => {
    expect(withoutFetchableUrls({
      background: "url(https://evil/x)",
      borderImage: "image-set('https://evil/y' 1x)",
      cursor: "-webkit-image-set(url(https://evil/z) 1x)",
      maskImage: "src(https://evil/w)",
      color: "var(--vendo-color-accent)",
      filter: "blur(4px)",
    })).toEqual({ color: "var(--vendo-color-accent)", filter: "blur(4px)" });
    expect(withoutFetchableUrls(undefined)).toBeUndefined();
  });

  it("drops them however the escapes spell the function", () => {
    // The CSS tokenizer unescapes before it decides what a token is, so every
    // one of these IS `url(` to the browser, whatever the raw string reads.
    expect(withoutFetchableUrls({
      background: "\\75 rl(https://evil/x)",
      borderImage: "\\000075rl(https://evil/y)",
      maskImage: "u\\72 l(https://evil/z)",
      WebkitMaskImage: "\\75 \\72 \\6c(https://evil/w)",
      clipPath: "u\\72 l(#c)",
      filter: "\\75 rl(#f)",
      cursor: "u\\72 l(https://evil/c), auto",
      content: "\\000075rl(https://evil/t)",
      listStyleImage: "u\\72 l(https://evil/l)",
      shapeOutside: "\\75 rl(https://evil/s)",
    })).toEqual({});

    // `var()` substitutes whole tokens, so the custom property carries the
    // escape through intact — it is the declaration that has to go.
    expect(withoutFetchableUrls({ "--x": "u\\72 l(/pixel)", background: "var(--x)" } as CSSProperties))
      .toEqual({ background: "var(--x)" });

    // Input preprocessing runs BEFORE escapes are read and collapses CRLF to one
    // newline, so the escape's single trailing whitespace swallows the whole
    // break and these spell `url(` too.
    expect(withoutFetchableUrls({
      background: "\\75\r\nrl(https://evil/x)",
      maskImage: "\\75\r\nrl(https://evil/z)",
      cursor: "\\75\r\nrl(https://evil/c), auto",
      content: "\\75\r\nrl(https://evil/t)",
      WebkitMaskBoxImage: "u\\72\r\nl(https://evil/b)",
    })).toEqual({});
    expect(withoutFetchableUrls({ "--y": "\\75\r\nrl(/pixel)", background: "var(--y)" } as CSSProperties))
      .toEqual({ background: "var(--y)" });
  });

  it("keeps the values that only look like a fetch", () => {
    expect(withoutFetchableUrls({
      filter: "blur(4px)",
      // A comment splits the ident, so this computes to nothing and fetches nothing.
      background: "ur/**/l(https://evil/x)",
    })).toEqual({ filter: "blur(4px)", background: "ur/**/l(https://evil/x)" });

    // `url\9 (` is inert too — whitespace between the ident and `(` is no
    // function token — but normalizing puts a tab where the escape was and the
    // filter's `\s*` takes it. Dropping a value that paints nothing is safe;
    // buying it back would cost a second mechanism.
    expect(withoutFetchableUrls({ background: "url\\9 (https://evil/x)" })).toEqual({});

    // One decode pass is the RIGHT number: the browser decodes once too, so
    // `\\75 rl(` is a literal backslash followed by text and paints nothing.
    expect(withoutFetchableUrls({ background: "\\\\75 rl(https://evil/x)" }))
      .toEqual({ background: "\\\\75 rl(https://evil/x)" });

    // The legitimate CSS the filter must never eat, whatever the property.
    for (const value of [
      "blur(4px)", "linear-gradient(red, blue)", "radial-gradient(circle, #123, #456)",
      "color-mix(in srgb, red 50%, blue)", '"url is a word"', "translateX(4px) blur(0)",
      "Blurb, Source Sans, sans-serif", "pointer", "none", "linear-gradient(red, blue) 30",
      '"a \\\\ b"', '"\\201C"', "repeat(auto-fill, minmax(120px, 1fr))",
    ]) expect(withoutFetchableUrls({ background: value })).toEqual({ background: value });
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
