// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVendoClient, VendoApproval, type VendoClient } from "../../src/index.js";
import { createWireServer } from "../wire-server.js";

// The ask as an outside agent's door ships it: the words are already chosen, so
// the component renders them and never re-derives them. `apr_1` is the wire
// fixture's OWN pending approval, so every decision below is spent over the real
// decide route — never against a stub that could only ever agree with us.
const ask = {
  id: "apr_1",
  question: "Send the report to a@example.com?",
  notes: ["To: a@example.com", "This changes something in your account, as you."],
};

describe("<VendoApproval>", () => {
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

  it("renders the shipped question, and every note as its own item", () => {
    const { container } = render(<VendoApproval approval={ask} client={client} />);
    // THE literal `<ApprovalCard>`, not a lookalike composed out of the same
    // shell: `fl-item-in` and the machine affordances beside it are that
    // component's own (approval-card.tsx), and the markup this replaced — which
    // passed every other assertion in this file — carried none of them.
    const shell = container.querySelector(".fl-approval")!;
    expect(shell.classList.contains("fl-item-in")).toBe(true);
    // The wire carries no grade, and "ungraded" is a first-class one: this ask
    // arrived as words, so nobody checked what it changes.
    expect(shell.getAttribute("data-risk")).toBe("ungraded");
    expect(container.querySelector(".fl-approval-ask")!.textContent).toBe(ask.question);
    const notes = container.querySelector("ul.fl-approval-sub")!;
    expect(notes.getAttribute("aria-label")).toBe("Request details");
    // The " · " leads every item but the first as REAL text, which is what the
    // clipboard sees (card-shell.tsx NOTE_SEPARATOR).
    expect(Array.from(notes.querySelectorAll("li")).map(item => item.textContent)).toEqual([
      "To: a@example.com",
      " · This changes something in your account, as you.",
    ]);
  });

  it("spends the decision on the wire under the shipped id, then settles into its receipt", async () => {
    const { container } = render(<VendoApproval approval={ask} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(container.querySelector(".fl-cardshell--settled")).not.toBeNull());
    expect(container.querySelector("p.fl-approval-sub")!.textContent).toBe("Approved — ran");
    expect(wire.requests.filter(entry => entry.path === "/approvals/decide").map(entry => entry.body)).toEqual([
      { ids: ["apr_1"], decision: { approve: true } },
    ]);
    // The yes really landed: the wire no longer has the ask waiting.
    expect(wire.state.approvals.some(item => item.id === "apr_1")).toBe(false);
    // A receipt has nothing left to press.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("spends a NO the same way, and settles into the declined receipt", async () => {
    const { container } = render(<VendoApproval approval={ask} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(container.querySelector(".fl-cardshell--settled")).not.toBeNull());
    const receipt = container.querySelector("p.fl-approval-sub")!;
    expect(receipt.textContent).toBe("Declined — nothing ran");
    // The settled card wears the failed treatment, which is the only thing that
    // says a no from a yes at a glance.
    expect(receipt.classList.contains("fl-approval-sub--failed")).toBe(true);
    expect(wire.requests.filter(entry => entry.path === "/approvals/decide").map(entry => entry.body)).toEqual([
      { ids: ["apr_1"], decision: { approve: false } },
    ]);
    // The no really landed: the wire no longer has the ask waiting.
    expect(wire.state.approvals.some(item => item.id === "apr_1")).toBe(false);
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("settles an ask that is no longer waiting, instead of reporting a failure", async () => {
    // Decided on another surface, or expired: the wire answers `not-found`, and
    // the question is settled — not broken.
    const { container } = render(<VendoApproval approval={{ ...ask, id: "apr_gone" }} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(container.querySelector(".fl-cardshell--settled")).not.toBeNull());
    expect(container.querySelector("p.fl-approval-sub")!.textContent)
      .toBe("This request isn’t waiting on you any more — it may have expired.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
