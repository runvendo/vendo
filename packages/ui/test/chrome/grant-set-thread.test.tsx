// @vitest-environment jsdom
// demo-live-readiness — the in-thread grant-SET consent card: one card
// enumerating every permission of an automation's standing-grant set, ONE
// Approve deciding all asks atomically, and any-surface resume (a decision
// announced with only the grantSetId resolves the parked card).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { APPROVALS_DECIDED_EVENT, type ApprovalsDecidedDetail } from "../../src/client-impl.js";
import { createWireServer } from "../wire-server.js";

describe("grant-set consent in the thread", () => {
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

  const parkOnGrantSet = async () => {
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[grant-set] arm the watcher" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    return await screen.findByLabelText("Standing access — Invoice watcher");
  };

  const threadPosts = () =>
    wire.requests.filter(request => request.method === "POST" && request.path === "/threads");

  it("enumerates every permission with exactly one Approve and one Deny (criterion 18)", async () => {
    const card = await parkOnGrantSet();
    expect(card.textContent).toContain("Invoice watcher needs 2 permissions");
    // Each permission in OUR words — the GRADE and the thing.
    // ⚠️ TEST EDIT (Yousef's grading ruling D1): this briefly asserted "Sends:
    // Email send", a word derived from the TOOL NAME. Name inference is gone;
    // the row reads the grade. The fixture's send ask is now graded `write`
    // (it was hardcoded `read`, which is what made the false row possible).
    expect(card.textContent).toContain("Changes: Email send");
    expect(card.textContent).not.toContain("Sends: Email send");
    expect(card.textContent).toContain("Reads: Invoices list");
    expect(card.textContent).not.toContain("Send email digests as you.");
    expect(card.querySelectorAll(".fl-grant")).toHaveLength(2);
    const buttons = [...card.querySelectorAll("button")].map(button => button.textContent);
    expect(buttons).toEqual(["Allow both & enable", "Deny"]);
    // The set card replaces the generic parked ApprovalCard — one consent
    // surface per ask, never two.
    expect(screen.queryByLabelText(/^Approval for /)).toBeNull();
  });

  it("Approve decides the WHOLE set in one wire call and resumes the turn (criterion 19)", async () => {
    const card = await parkOnGrantSet();
    fireEvent.click(screen.getByRole("button", { name: "Allow both & enable" }));

    await waitFor(() => expect(wire.requests).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/approvals/decide",
      body: { ids: ["apr_set_1", "apr_set_2"], decision: { approve: true } },
    })));
    // The native approval response resumes the parked turn (the assistant
    // upsert the resume rides), and the card settles into the approved record.
    await waitFor(() => expect(threadPosts().length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(card.textContent).toContain("Enabled · 2 permissions granted"));
    expect(card.querySelector("button")).toBeNull();
  });

  it("a panel decision announced with ONLY the grantSetId resolves the parked card (criterion 20)", async () => {
    await parkOnGrantSet();
    const before = threadPosts().length;

    act(() => {
      const detail: ApprovalsDecidedDetail = { ids: [], approved: true, grantSetId: "gset_1" };
      window.dispatchEvent(new CustomEvent(APPROVALS_DECIDED_EVENT, { detail }));
    });

    // The parked card resolves: the thread sends the native approval response
    // (the resume upsert) without any in-thread click.
    await waitFor(() => expect(threadPosts().length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByLabelText("Standing access — Invoice watcher").textContent)
      .toContain("Enabled · 2 permissions granted"));
  });

  it("Deny settles the record without granting (criterion 19, deny half)", async () => {
    const card = await parkOnGrantSet();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(wire.requests).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/approvals/decide",
      body: { ids: ["apr_set_1", "apr_set_2"], decision: { approve: false } },
    })));
    await waitFor(() => expect(card.textContent).toContain("Denied — the automation stays paused."));
  });
});

/** H13 — the wire shape was CAST after an `Array.isArray` check, so a malformed
 *  member rendered a row with no verb (": Send money") and pushed an undefined
 *  id into the decision call. */
describe("the grant-set wire shape is validated, not cast (H13)", () => {
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

  const part = (permissions: unknown[]) => ({
    type: "data-vendo-grant-set",
    data: { toolCallId: "call_1", grantSetId: "gset_1", name: "Invoice watcher", permissions },
  }) as never;

  const show = (permissions: unknown[]) => render(
    <VendoProvider client={client}>
      <ThreadPart part={part(permissions)} partKey="m-0" role="assistant" restored={false} risks={new Map()} />
    </VendoProvider>,
  );

  it("drops a member with no risk and keeps the graded ones", () => {
    show([
      { approvalId: "apr_1", tool: "host_transferMoney" },
      { approvalId: "apr_2", tool: "host_invoices_list", risk: "read" },
    ]);
    const rows = [...document.querySelectorAll(".fl-grant")].map(row => row.textContent);
    expect(rows).toEqual(["Reads: Invoices list"]);
    expect(rows.some(row => row?.startsWith(": "))).toBe(false);
    expect(document.body.textContent).toContain("needs 1 permission");
  });

  it("drops a member with an unknown risk, a missing id, or a non-object entry", () => {
    show([
      { approvalId: "apr_1", tool: "host_transferMoney", risk: "catastrophic" },
      { tool: "host_invoices_list", risk: "read" },
      "apr_3",
      null,
      { approvalId: "apr_4", tool: "host_invoices_list", risk: "read" },
    ]);
    expect([...document.querySelectorAll(".fl-grant")]).toHaveLength(1);
  });

  it("renders NO card when nothing in the set survives — never decide([undefined])", () => {
    show([{ tool: "host_transferMoney" }, { risk: "read" }]);
    expect(screen.queryByLabelText(/^Standing access/)).toBeNull();
  });
});
