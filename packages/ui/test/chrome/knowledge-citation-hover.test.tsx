// @vitest-environment jsdom
// Knowledge K1 — the citation card's REACHABILITY. The card opens 8px below its
// chip, so the CSS :hover reveal it used to ship with died in that gap: the
// pointer left the chip before it arrived on the card, and the snippet could
// never be read by hovering. Hover intent (open on enter, close on a grace) with
// click-to-pin replaces it; these are the behaviours that gap cost us. The
// geometry itself — travel paths, the edge clamp — is proven in a real browser.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnCitations } from "../../src/chrome/thread/turn-citations.js";

const CITATIONS = [
  {
    docId: "doc-refunds",
    chunkId: "doc-refunds#0",
    title: "Refunds & cancellations",
    source: "docs/refunds.md",
    kind: "docs",
    visibility: "public",
    snippet: "If you cancel mid-cycle we do not charge again.",
  },
  {
    docId: "doc-faq",
    title: "Billing FAQ",
    source: "docs/faq.md",
    kind: "docs",
    visibility: "public",
    snippet: "Seats removed mid-cycle are credited to the final invoice.",
  },
];

function citationsTurn(): UIMessage {
  return {
    id: "msg_knowledge",
    role: "assistant",
    parts: [
      {
        type: "data-vendo-citations",
        data: { toolCallId: "call_search", citations: CITATIONS, outcome: "answered" },
      } as UIMessage["parts"][number],
    ],
  };
}

describe("citation card reachability (Knowledge K1)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const chips = () => [...document.querySelectorAll<HTMLElement>(".fl-cite")];
  const openChips = () => [...document.querySelectorAll(".fl-cite--open")];
  const button = (name: RegExp) => screen.getByRole("button", { name });

  const mount = () => render(<TurnCitations message={citationsTurn()} />);

  it("opens the card on hover and holds it through the grace on the way out", () => {
    vi.useFakeTimers();
    mount();
    const [first] = chips();

    fireEvent.pointerEnter(first);
    expect(button(/Refunds & cancellations/).getAttribute("aria-expanded")).toBe("true");

    // Leaving does NOT close it: this window is the pointer's travel across the
    // 8px gap, and it is exactly what the old CSS :hover rule had no way to give.
    fireEvent.pointerLeave(first);
    act(() => void vi.advanceTimersByTime(200));
    expect(openChips()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(100));
    expect(openChips()).toHaveLength(0);
    expect(button(/Refunds & cancellations/).getAttribute("aria-expanded")).toBe("false");
  });

  it("arriving on the card cancels the pending close", () => {
    vi.useFakeTimers();
    mount();
    const [first] = chips();

    fireEvent.pointerEnter(first);
    fireEvent.pointerLeave(first);
    act(() => void vi.advanceTimersByTime(150));
    // The card is a child of .fl-cite, so landing on it re-enters this very
    // element whatever path the pointer took to get there.
    fireEvent.pointerEnter(first);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(openChips()).toHaveLength(1);
  });

  it("a click pins the card, so it survives the pointer leaving", () => {
    vi.useFakeTimers();
    mount();
    const [first] = chips();

    fireEvent.pointerEnter(first);
    fireEvent.click(button(/Refunds & cancellations/));
    fireEvent.pointerLeave(first);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(openChips()).toHaveLength(1);

    // Re-entering a pinned card must not quietly un-pin it.
    fireEvent.pointerEnter(first);
    fireEvent.pointerLeave(first);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(openChips()).toHaveLength(1);
  });

  it("Escape and an outside click both dismiss a pinned card", () => {
    mount();
    fireEvent.click(button(/Refunds & cancellations/));
    expect(openChips()).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(openChips()).toHaveLength(0);

    fireEvent.click(button(/Refunds & cancellations/));
    expect(openChips()).toHaveLength(1);
    fireEvent.pointerDown(document.body);
    expect(openChips()).toHaveLength(0);
  });

  it("entering another chip closes the first — never two cards at once", () => {
    mount();
    const [first, second] = chips();

    fireEvent.pointerEnter(first);
    fireEvent.pointerEnter(second);
    expect(openChips()).toEqual([second]);
    expect(button(/Refunds & cancellations/).getAttribute("aria-expanded")).toBe("false");
    expect(button(/Billing FAQ/).getAttribute("aria-expanded")).toBe("true");
  });

  it("a pinned card gives way to another chip's hover too", () => {
    mount();
    const [, second] = chips();

    fireEvent.click(button(/Refunds & cancellations/));
    fireEvent.pointerEnter(second);
    expect(openChips()).toEqual([second]);
  });

  // The touch guard (pointerType) has no home here: jsdom 25 ships no
  // PointerEvent, so every synthetic pointer event arrives with an undefined
  // pointerType and a touch device cannot be impersonated. Tap behaviour is
  // proven on a real touchscreen context in the browser pass instead.
});
