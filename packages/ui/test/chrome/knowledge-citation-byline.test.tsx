// @vitest-environment jsdom
// Knowledge K1 — the citation card's origin byline STAYS INSIDE the card. The
// byline is a nowrap flex row so no segment breaks mid-item ("Product docs" once
// split down the middle), but the source is the one segment that can outgrow the
// 292px card on its own, and nowrap leaves it no break at all: a 64-char
// help.maple.bank path painted 77px past the border and handed .fl-msglist
// horizontal scroll. Constraining it needs it to be a REAL element — an
// anonymous flex item takes neither a min-width floor nor an ellipsis.
//
// jsdom reports every rect as zero and implements no text-overflow, so the
// truncation itself is only provable in a real browser (before/after screenshots
// in the PR). What is provable here is the seam that makes it possible, with no
// stub on either side: the component emits the element, and the stylesheet the
// component actually ships with constrains that same class.
import { cleanup, render } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { TurnCitations } from "../../src/chrome/thread/turn-citations.js";

/** Long enough to overrun the card on its own at the byline's 11px. */
const LONG_SOURCE = "help.maple.bank/en-us/articles/how-refunds-and-cancellations-work";

function citationsTurn(source?: string): UIMessage {
  return {
    id: "msg_knowledge",
    role: "assistant",
    parts: [
      {
        type: "data-vendo-citations",
        data: {
          toolCallId: "call_search",
          outcome: "answered",
          citations: [{
            docId: "doc-refunds",
            title: "Refunds & cancellations",
            ...(source === undefined ? {} : { source }),
            kind: "docs",
            visibility: "public",
            snippet: "If you cancel mid-cycle we do not charge again.",
          }],
        },
      } as UIMessage["parts"][number],
    ],
  };
}

describe("citation byline containment (Knowledge K1)", () => {
  afterEach(cleanup);

  const byline = () => document.querySelector(".fl-cite-porigin");

  it("gives the source its own element, and truncation costs the text nothing", () => {
    render(<TurnCitations message={citationsTurn(LONG_SOURCE)} />);

    expect(byline()?.querySelector(".fl-cite-psource")?.textContent).toBe(LONG_SOURCE);
    // Only the source gets one. Kind and visibility stay anonymous items because
    // the container's nowrap is all they need — neither can outgrow the card.
    expect(byline()?.querySelectorAll(":scope > span:not(.fl-cite-sep)")).toHaveLength(1);
    // The cut is paint-only: the full source is still the byline's text, so a
    // screen reader and a copied selection both keep every character of it.
    expect(byline()?.textContent).toBe(`${LONG_SOURCE}·Product docs·public`);
  });

  it("emits no source element when the citation carries no source", () => {
    render(<TurnCitations message={citationsTurn()} />);

    expect(byline()?.querySelector(".fl-cite-psource")).toBeNull();
    expect(byline()?.textContent).toBe("Product docs·public");
  });

  it("ships the rule that constrains it in the chrome stylesheet", async () => {
    const { CHROME_CSS } = await import("../../src/chrome/chrome-css.js");

    // min-width:0 lifts the min-content floor every flex item carries; without
    // it the source refuses to shrink and paints past the card's border.
    expect(CHROME_CSS).toContain(".fl-cite-psource { min-width: 0; overflow: hidden; text-overflow: ellipsis; }");
    // And the pair that keeps wrapping BETWEEN segments is still on the row.
    expect(CHROME_CSS).toContain(".fl-cite-porigin { font-size: 11px;");
    expect(CHROME_CSS).toContain("flex-wrap: wrap; white-space: nowrap; }");
  });
});
