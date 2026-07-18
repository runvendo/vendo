// @vitest-environment jsdom
// VendoActivities — the shelf's drop-in combined feed (ui-usage-dx §2):
// pending approvals render on top as actionable cards, recent agent activity
// renders humanized below, with a quiet empty state so the piece is visible
// (but not loud) when nothing has happened yet.
import type { ApprovalRequest } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoActivities } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** A second pending approval the poll test raises server-side mid-session. */
function raisedApproval(): ApprovalRequest {
  return {
    id: "apr_2",
    call: { id: "call_2", tool: "host_email_send", args: { to: "b@example.com" } },
    descriptor: {
      name: "host_email_send",
      description: "Send email",
      inputSchema: { type: "object" },
      risk: "write",
    },
    inputPreview: "to b@example.com",
    ctx: {
      principal: { kind: "user", subject: "user_1" },
      venue: "chat",
      presence: "present",
    },
    createdAt: "2026-07-11T12:00:00.000Z",
  };
}

describe("VendoActivities", () => {
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

  const mount = (props: { pollMs?: number; maxItems?: number } = {}) =>
    render(<VendoProvider client={client}><VendoActivities {...props} /></VendoProvider>);

  it("renders pending approvals as decidable cards and decisions call through", async () => {
    mount();
    expect(await screen.findByLabelText("Approval for Email send")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs your approval" })).toBeTruthy();
    // Keyboard-decidable: the decision affordances are native buttons.
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.tagName).toBe("BUTTON");
    fireEvent.click(approve);
    await waitFor(() => expect(screen.queryByLabelText("Approval for Email send")).toBeNull());
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/approvals/decide" }),
    );
    // The approvals section disappears entirely once the queue drains.
    expect(screen.queryByRole("heading", { name: "Needs your approval" })).toBeNull();
  });

  it("omits the approvals section when the queue is empty", async () => {
    wire.state.approvals = [];
    mount();
    await waitFor(() => expect(screen.getAllByText("Invoices list").length).toBeGreaterThan(0));
    expect(screen.queryByRole("heading", { name: "Needs your approval" })).toBeNull();
  });

  it("renders recent activity humanized with human timestamps and outcomes", async () => {
    mount();
    // The raw slug host_invoices_list is humanized at the render site (ENG-216/224).
    await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(2));
    expect(screen.getAllByText("Jul 11, 2026, 12:00 PM").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Succeeded").length).toBeGreaterThan(0);
  });

  it("caps the feed at maxItems", async () => {
    mount({ maxItems: 1 });
    await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(1));
  });

  it("shows a quiet empty state when nothing has run and nothing is pending", async () => {
    wire.state.approvals = [];
    wire.state.events = [];
    mount();
    expect(await screen.findByText("No recent agent activity yet.")).toBeTruthy();
  });

  it("is a labeled region", async () => {
    mount();
    expect(await screen.findByRole("region", { name: "Vendo activity" })).toBeTruthy();
  });

  it("polls so an approval raised elsewhere appears without a remount", async () => {
    wire.state.approvals = [];
    mount({ pollMs: 40 });
    await waitFor(() => expect(screen.getAllByText("Invoices list").length).toBeGreaterThan(0));
    expect(screen.queryByRole("heading", { name: "Needs your approval" })).toBeNull();
    wire.state.approvals = [raisedApproval()];
    expect(await screen.findByLabelText("Approval for Email send")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs your approval" })).toBeTruthy();
  });
});
