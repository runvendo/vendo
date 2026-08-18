// @vitest-environment jsdom
// The layout tier's own contract. jsdom lays nothing out, so what these pin is
// the STYLE a browser is then asked to honor — the browser half of SplitPane's
// promise lives in the e2e shot, and the tracks below are what that shot depends
// on.
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card, SplitPane } from "../../src/kit/layout.js";
import { Text } from "../../src/kit/values.js";

const split = (element: ReturnType<typeof render>): HTMLElement =>
  element.container.querySelector<HTMLElement>('[data-kit="SplitPane"]')!;

/** A Card's description slot: with no title, header or footer it is the card's
 *  only `div`, and there is no slot at all when nothing was put in it. */
const description = (element: ReturnType<typeof render>): HTMLElement | null =>
  element.container.querySelector<HTMLElement>('[data-kit="Card"] > div');

describe("Card", () => {
  /** THE FAILURE: `description` was typed `string`, so a screen whose subtitle
   *  carried a VALUE — a mono `branch·sha` pair — had no way to put a Kit mark
   *  there and hand-rolled unstyled text instead. Every card in the ecosystem
   *  takes a node here (MUI `CardHeader.subheader`, AntD `Card.Meta.description`);
   *  `tsc` over this file is half the test, the paint below is the other half. */
  it("takes a Kit mark as its description, in the description slot", () => {
    const slot = description(render(<Card description={<Text variant="code" text="main·9f2c1ab" />} />))!;
    expect(slot.firstElementChild?.getAttribute("data-variant")).toBe("code");
    expect(slot.style.fontSize).toBe("0.9em");
  });

  /** And a string is untouched, the empty one included: an unwritten description
   *  paints no slot, so it still costs no row and no gap. */
  it("paints a string in that same slot, and nothing at all for an empty one", () => {
    expect(description(render(<Card description="main·9f2c1ab" />))!.textContent).toBe("main·9f2c1ab");
    expect(description(render(<Card description="" />))).toBeNull();
  });
});

/**
 * jsdom lays nothing out and ships no ResizeObserver, so a pane can never be
 * narrow in a test — which is exactly why every test above it here renders
 * side-by-side untouched. State the width the component measures and hand back
 * the observer's callback, so a test can drive a real resize; the component still
 * does its own measuring and its own stacking.
 */
function stubWidth(initial: number) {
  const observers = globalThis.ResizeObserver;
  let resize = () => {};
  let clientWidth = initial;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => clientWidth });
  return {
    /** A resize the surface really had. */
    resizeTo: (next: number) => { clientWidth = next; act(() => resize()); },
    restore: () => {
      globalThis.ResizeObserver = observers;
      // `delete` needs a writable view — clientWidth is readonly on HTMLElement.
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    },
  };
}

describe("SplitPane", () => {
  /** The one arrangement the Kit could not express. Row and Grid both wrap; a
   *  screen asked for a list beside the record it opens drew it in raw CSS
   *  instead, or stacked the two and lost the layout the person described. */
  it("lays two panes as tracks, the first at the width it was given", () => {
    const pane = split(render(
      <SplitPane size={280}>
        <Text text="list" />
        <Text text="detail" />
      </SplitPane>,
    ));
    expect(pane.style.display).toBe("grid");
    expect(pane.style.gridTemplateColumns).toBe("minmax(0, 280px) minmax(0, 1fr)");
  });

  /** ONE meaning for size: a string is the CSS length it says it is. "40%" is
   *  how a split is described out loud, and it used to be unsayable — the number
   *  below carried the share, so every other unit had no way in at all. */
  it("takes a CSS length verbatim", () => {
    for (const [size, first] of [["40%", "40%"], ["18rem", "18rem"], ["280px", "280px"]] as const) {
      expect(split(render(<SplitPane size={size}><Text text="a" /><Text text="b" /></SplitPane>)).style.gridTemplateColumns, size)
        .toBe(`minmax(0, ${first}) minmax(0, 1fr)`);
    }
  });

  /** Below 1 it is a share of the split. Only tolerated now that a string says
   *  the same thing plainly — but stored screens carry the float, so it keeps
   *  meaning what it always meant. A pane 0.4 pixels wide is not a layout, so
   *  there is no second reading of the number to get wrong. */
  it("still reads a size below 1 as a share of the split", () => {
    expect(split(render(<SplitPane size={0.4}><Text text="a" /><Text text="b" /></SplitPane>)).style.gridTemplateColumns)
      .toBe("minmax(0, 40%) minmax(0, 1fr)");
  });

  /** NEVER WRAPS — the property the whole component exists for. A third child
   *  becomes a third column, not a second row, so nothing a screen writes can
   *  turn side-by-side back into stacked. */
  it("never wraps: an extra child is another column", () => {
    const pane = split(render(
      <SplitPane><Text text="a" /><Text text="b" /><Text text="c" /></SplitPane>,
    ));
    expect(pane.style.gridAutoFlow).toBe("column");
    expect(pane.style.gridAutoColumns).toBe("minmax(0, 1fr)");
  });

  /** Each pane owns its own overflow, floored at zero width — the same
   *  `minmax(0, …)` a CodeBlock needs, for the same reason: a wide table inside
   *  one pane must scroll in ITS pane rather than push the other off the frame. */
  it("gives every pane its own scroll and a zero floor", () => {
    const panes = [...split(render(
      <SplitPane><Text text="a" /><Text text="b" /></SplitPane>,
    )).children] as HTMLElement[];
    expect(panes).toHaveLength(2);
    for (const one of panes) {
      expect(one.style.overflow).toBe("auto");
      expect(one.style.minWidth).toBe("0");
    }
  });

  it("still lets a caller override the layout it defaults to", () => {
    expect(split(render(
      <SplitPane style={{ gap: "24px" }}><Text text="a" /><Text text="b" /></SplitPane>,
    )).style.gap).toBe("24px");
  });

  /**
   * THE FAILURE: on a frame too narrow for both, the second pane was squeezed to
   * a sliver and clipped — the detail half of "a list beside the thing it opens"
   * was simply not on screen. Narrow, the same two panes flow as ROWS: one
   * full-width track, and `row` auto-flow so a third child is a third row rather
   * than the implicit column that put it back off-frame.
   */
  it("stacks the panes on a frame too narrow to hold both", () => {
    const layout = stubWidth(400);
    try {
      const pane = split(render(<SplitPane><Text text="a" /><Text text="b" /></SplitPane>));
      expect(pane.getAttribute("data-stacked")).toBe("");
      expect(pane.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
      expect(pane.style.gridAutoFlow).toBe("row");
      // Each pane still owns its own overflow — stacked is the same two boxes.
      for (const one of [...pane.children] as HTMLElement[]) expect(one.style.overflow).toBe("auto");
    } finally {
      layout.restore();
    }
  });

  /** And back: the arrangement follows the frame, so a pane that is given room
   *  again is side by side again. Nothing latches. */
  it("returns to two tracks when the frame is wide enough again", () => {
    const layout = stubWidth(400);
    try {
      const pane = split(render(<SplitPane size={280}><Text text="a" /><Text text="b" /></SplitPane>));
      expect(pane.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
      layout.resizeTo(900);
      expect(pane.getAttribute("data-stacked")).toBeNull();
      expect(pane.style.gridTemplateColumns).toBe("minmax(0, 280px) minmax(0, 1fr)");
      expect(pane.style.gridAutoFlow).toBe("column");
    } finally {
      layout.restore();
    }
  });
});
