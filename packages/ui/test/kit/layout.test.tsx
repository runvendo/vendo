// @vitest-environment jsdom
// The layout tier's own contract. jsdom lays nothing out, so what these pin is
// the STYLE a browser is then asked to honor — the browser half of SplitPane's
// promise lives in the e2e shot, and the tracks below are what that shot depends
// on.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SplitPane } from "../../src/kit/layout.js";
import { Text } from "../../src/kit/values.js";

const split = (element: ReturnType<typeof render>): HTMLElement =>
  element.container.querySelector<HTMLElement>('[data-kit="SplitPane"]')!;

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

  /** Below 1 it is a share of the split. A pane 0.4 pixels wide is not a layout,
   *  so there is no second reading of the number to get wrong. */
  it("reads a size below 1 as a share of the split", () => {
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
});
