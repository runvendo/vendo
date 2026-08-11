// @vitest-environment jsdom
// Knowledge K1 — a turn that searched the knowledge base streams a
// `data-vendo-citations` part (agent tool bridge); the thread renders the
// signed mockup's Surface-2 states from its OUTCOME: citation chips with the
// snippet popover (answered), the muted searched-line (insufficient-evidence),
// and the amber knowledge-unavailable flag (unavailable).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoThread } from "../../src/chrome/index.js";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { createWireServer } from "../wire-server.js";

function citationsTurn(outcome: string, citations: unknown[]): UIMessage {
  return {
    id: "msg_knowledge",
    role: "assistant",
    parts: [
      {
        type: "data-vendo-citations",
        data: { toolCallId: "call_search", citations, outcome },
      } as UIMessage["parts"][number],
      { type: "text", text: "Here is what the documentation says." },
    ],
  };
}

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

describe("knowledge citations in the thread (Knowledge K1)", () => {
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

  async function renderThreadWith(turn: UIMessage) {
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", { ...existing, messages: [...existing.messages, turn] });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Here is what the documentation says.");
  }

  it("renders the labelled SOURCES chip row with doc titles for a grounded answer", async () => {
    await renderThreadWith(citationsTurn("answered", CITATIONS));

    const row = document.querySelector("[data-vendo-citations]");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".fl-cites-label")?.textContent).toBe("Sources");
    const chips = [...document.querySelectorAll(".fl-cite-btn")];
    expect(chips.map(chip => chip.textContent)).toEqual(["Refunds & cancellations", "Billing FAQ"]);
    // Neither trust flag renders on a grounded turn.
    expect(document.querySelector("[data-vendo-knowledge-searched]")).toBeNull();
    expect(document.querySelector("[data-vendo-knowledge-unavailable]")).toBeNull();
  });

  it("opens the snippet popover with the quoted snippet and origin line on click", async () => {
    await renderThreadWith(citationsTurn("answered", CITATIONS));

    const chip = screen.getByRole("button", { name: /Refunds & cancellations/ });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const open = document.querySelector(".fl-cite--open");
    expect(open).toBeTruthy();
    const pop = open!.querySelector(".fl-cite-pop")!;
    expect(pop.querySelector(".fl-cite-psnippet")?.textContent).toContain("If you cancel mid-cycle we do not charge again.");
    expect(pop.querySelector(".fl-cite-porigin")?.textContent).toContain("docs/refunds.md");
    expect(pop.querySelector(".fl-cite-porigin")?.textContent).toContain("Product docs");
    // The mockup's three-segment origin line: source · kind · visibility.
    expect(pop.querySelector(".fl-cite-porigin")?.textContent).toContain("public");
    // Click again to collapse.
    fireEvent.click(chip);
    expect(document.querySelector(".fl-cite--open")).toBeNull();
  });

  it("renders the searched-line refusal for an insufficient-evidence outcome", async () => {
    await renderThreadWith(citationsTurn("insufficient-evidence", []));

    const line = document.querySelector("[data-vendo-knowledge-searched]");
    expect(line).toBeTruthy();
    expect(line?.textContent).toContain("Searched the knowledge base — no matching documentation");
    expect(document.querySelector("[data-vendo-citations]")).toBeNull();
    expect(document.querySelector("[data-vendo-knowledge-unavailable]")).toBeNull();
  });

  it("renders the amber unavailable flag for an engine outage", async () => {
    await renderThreadWith(citationsTurn("unavailable", []));

    const flag = document.querySelector("[data-vendo-knowledge-unavailable]");
    expect(flag).toBeTruthy();
    expect(flag?.textContent).toContain("knowledge base is temporarily unreachable");
    expect(document.querySelector("[data-vendo-knowledge-searched]")).toBeNull();
  });

  it("never renders the legacy read-tool source chips on a knowledge-citation turn", async () => {
    // The pre-chrome-wave `.fl-sources` read-call row is gone from the chrome;
    // a citations turn must not resurrect anything shaped like it.
    await renderThreadWith(citationsTurn("answered", CITATIONS));
    expect(document.querySelector(".fl-sources")).toBeNull();
    expect(document.querySelector(".fl-source")).toBeNull();
  });

  it("regression: a turn with no citations part renders none of the knowledge surfaces", async () => {
    await renderThreadWith({
      id: "msg_plain",
      role: "assistant",
      parts: [{ type: "text", text: "Here is what the documentation says." }],
    });
    expect(document.querySelector("[data-vendo-citations]")).toBeNull();
    expect(document.querySelector("[data-vendo-knowledge-searched]")).toBeNull();
    expect(document.querySelector("[data-vendo-knowledge-unavailable]")).toBeNull();
    expect(document.querySelector(".fl-cite-btn")).toBeNull();
  });

  it("dedupes the same doc across multiple knowledge calls in one turn", async () => {
    await renderThreadWith({
      id: "msg_two_calls",
      role: "assistant",
      parts: [
        {
          type: "data-vendo-citations",
          data: { toolCallId: "call_1", citations: [CITATIONS[0]], outcome: "answered" },
        } as UIMessage["parts"][number],
        {
          type: "data-vendo-citations",
          data: { toolCallId: "call_2", citations: CITATIONS, outcome: "answered" },
        } as UIMessage["parts"][number],
        { type: "text", text: "Here is what the documentation says." },
      ],
    });
    expect([...document.querySelectorAll(".fl-cite-btn")]).toHaveLength(2);
  });
});
