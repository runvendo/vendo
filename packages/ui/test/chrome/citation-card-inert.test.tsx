// @vitest-environment jsdom
// The citation card portals to <body> now, which puts it in the blast radius of
// `inertBehind` — the overlay panel and the approval modal inert every body
// child that is not theirs. An inert card is invisible to hit testing: it keeps
// its z-index, its `pointer-events: auto` and its pixels, but it is absent from
// elementsFromPoint, a wheel over it scrolls nothing, and the pointer never
// enters it, so walking toward it dismisses it en route. The toast region hit
// exactly this and answered with `data-vendo-portal`; this is the seam between
// the card's own attributes and the real matcher that reads them.
import { cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoThread } from "../../src/chrome/index.js";
import { inertBehind } from "../../src/chrome/inert-behind.js";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { createWireServer } from "../wire-server.js";

const CITATIONS = [{
  docId: "doc-refunds",
  chunkId: "doc-refunds#0",
  title: "Refunds & cancellations",
  source: "docs/refunds.md",
  kind: "docs",
  visibility: "public",
  snippet: "If you cancel mid-cycle we do not charge again.",
}];

const TURN: UIMessage = {
  id: "msg_knowledge",
  role: "assistant",
  parts: [
    {
      type: "data-vendo-citations",
      data: { toolCallId: "call_search", citations: CITATIONS, outcome: "answered" },
    } as UIMessage["parts"][number],
    { type: "text", text: "Here is what the documentation says." },
  ],
};

describe("the citation card under a modal surface", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  it("stays reachable when a body-level surface inerts everything behind it", async () => {
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", { ...existing, messages: [...existing.messages, TURN] });
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Here is what the documentation says.");

    const card = document.querySelector(".fl-cite-pop") as HTMLElement;
    expect(card, "the card portals to <body>").toBeTruthy();
    expect(card.parentElement, "…as a direct child, so inertBehind sees it").toBe(document.body);

    // A modal surface opens, exactly as the overlay panel does.
    const surface = document.body.appendChild(document.createElement("div"));
    const release = inertBehind(surface);

    // Control: the transcript behind the surface really was inerted, so a card
    // that is not inert is exempt rather than merely unvisited.
    expect(view.container.hasAttribute("inert"), "the thread behind is inert").toBe(true);
    expect(card.hasAttribute("inert"), "the card must take pointer input").toBe(false);

    release();
    surface.remove();
    expect(view.container.hasAttribute("inert")).toBe(false);
  });
});
