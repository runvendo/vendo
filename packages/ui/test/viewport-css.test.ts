import { describe, expect, it } from "vitest";
import { normalizeViewportBlockCss } from "../src/tree/jail/viewport-css.js";

// Existing-agents polish — the stylesheet arm of the jail's viewport-height
// normalization. Inside an auto-sized iframe a viewport-relative BLOCK
// constraint makes "content height" depend on the previous host height (the
// embed-whitespace ratchet); the runtime already normalizes inline styles,
// and generated islands that ship the same constraint in a <style> tag must
// get the identical treatment: height→auto, min-height→0, everything else
// untouched.
describe("normalizeViewportBlockCss", () => {
  it("rewrites viewport-height block constraints to their content-sized forms", () => {
    expect(normalizeViewportBlockCss(".page { min-height: 100vh; }"))
      .toBe(".page { min-height: 0; }");
    expect(normalizeViewportBlockCss(".page{height:100vh}"))
      .toBe(".page{height:auto}");
    expect(normalizeViewportBlockCss(".page { block-size: 50vb; }"))
      .toBe(".page { block-size: auto; }");
    expect(normalizeViewportBlockCss(".page { min-block-size: 100dvh; }"))
      .toBe(".page { min-block-size: 0; }");
  });

  it("rewrites calc() and small-/large-viewport variants", () => {
    expect(normalizeViewportBlockCss(".page { height: calc(100vh - 40px); }"))
      .toBe(".page { height: auto; }");
    expect(normalizeViewportBlockCss(".page { min-height: 100svh; }"))
      .toBe(".page { min-height: 0; }");
    expect(normalizeViewportBlockCss(".page { height: 100lvh !important; }"))
      .toBe(".page { height: auto; }");
  });

  it("leaves non-viewport and non-growing declarations alone", () => {
    const untouched = [
      ".page { min-height: 100%; }",
      ".page { height: 320px; }",
      ".page { max-height: 80vh; }",
      ".page { line-height: 1.5; }",
      ".page { padding-top: 10vh; }",
      ".page { width: 100vw; }",
      "html, body { margin: 0; height: 100%; }",
    ];
    for (const css of untouched) expect(normalizeViewportBlockCss(css)).toBe(css);
  });

  it("is idempotent, so re-measuring never mutates the sheet again", () => {
    const once = normalizeViewportBlockCss(".page { min-height: 100vh; height: 50vh; }");
    expect(normalizeViewportBlockCss(once)).toBe(once);
  });
});
