// @vitest-environment jsdom
/** ui-lane-cards converged picks: 1-A consequence-first, 1-H approval sheet,
    2-A brand-forward connect, 3-A′ tray marks, 4-C activity dock, 7-A liveness. */
import type { ApprovalRequest } from "@vendoai/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ApprovalCard, ApprovalSheet, AutomationsPanel, ConnectCard } from "../../src/chrome/index.js";
import { toolPresentation } from "../../src/chrome/build-beat.js";
import { ACTIVITY_ANCHOR_ATTRIBUTE, ACTIVITY_BUMP_EVENT, MorphToast } from "../../src/chrome/morph-toast.js";
import { toolkitDisplayName } from "../../src/chrome/humanize.js";
import { createWireServer } from "../wire-server.js";

const slackApproval: ApprovalRequest = {
  id: "apr_slack",
  call: {
    id: "call_slack",
    tool: "slack_SLACK_SEND_MESSAGE",
    args: { channel: "#renewals", message: "Morning digest: 7 renewals in the next 30 days, 2 at risk." },
  },
  descriptor: { name: "slack_SLACK_SEND_MESSAGE", description: "Post a message.", inputSchema: {}, risk: "write" },
  inputPreview: "channel: #renewals",
  ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
  createdAt: "2026-07-18T08:00:00.000Z",
};

describe("lane-cards picks", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await wire?.close();
  });

  it("1-A: synthesizes a structured consequence from the real Slack inputs", () => {
    const presentation = toolPresentation("slack_SLACK_SEND_MESSAGE", slackApproval.call.args);
    expect(presentation.consequence).toEqual({
      pre: "Vendo will post ",
      artifact: "“Morning digest: 7 renewals in the next 30 days, 2 at risk.”",
      mid: " to ",
      target: "#renewals",
      post: " — now, as you.",
    });
    // Unknown toolkits synthesize nothing — the card keeps its fields layout.
    expect(toolPresentation("host_delete_invoice", { invoiceId: "inv_42" }).consequence).toBeUndefined();
    // Gmail synthesizes nothing either (PR #391 P1): a sentence naming only
    // `to` would fold the subject/body/copied recipients out of sight, so the
    // card keeps every input in plain view.
    expect(toolPresentation("gmail_GMAIL_SEND_EMAIL", {
      to: "alice@example.com",
      subject: "Q3 renewals digest",
      body: "Northwind and Contoso renew this month.",
    }).consequence).toBeUndefined();
  });

  it("1-A: leads with the consequence and folds the real inputs behind Details", () => {
    render(<VendoProvider client={client}><ApprovalCard approval={slackApproval} onDecide={() => undefined} /></VendoProvider>);
    const sentence = document.querySelector(".fl-approval-consequence-line");
    expect(sentence?.textContent).toContain("Vendo will post");
    expect(sentence?.textContent).toContain("#renewals");
    // The fields never leave the DOM — folded, same a11y name.
    const details = document.querySelector("details.fl-approval-details");
    expect(details).not.toBeNull();
    expect(screen.getByLabelText("Real tool inputs").closest("details")).toBe(details);
  });

  it("1-A: a destructive ask keeps every input in plain sight (no fold)", () => {
    const critical: ApprovalRequest = {
      ...slackApproval,
      descriptor: { ...slackApproval.descriptor, risk: "destructive" },
    };
    render(<VendoProvider client={client}><ApprovalCard approval={critical} onDecide={() => undefined} /></VendoProvider>);
    expect(document.querySelector(".fl-approval-consequence-line")).toBeNull();
    expect(document.querySelector("details.fl-approval-details")).toBeNull();
    expect(screen.getByLabelText("Real tool inputs")).toBeTruthy();
  });

  it("1-H: the sheet is a decide-only dialog — Esc does not dismiss", () => {
    render(
      <VendoProvider client={client}>
        <ApprovalSheet label="Approval for Post to #renewals in Slack">
          <ApprovalCard approval={slackApproval} onDecide={() => undefined} />
        </ApprovalSheet>
      </VendoProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Approval for Post to #renewals in Slack" });
    expect(dialog.classList.contains("fl-approval-sheet")).toBe(true);
    // The card renders inside, chrome intact for the morph start-rect lookup.
    expect(dialog.querySelector(".fl-approval")).not.toBeNull();
    // Esc is swallowed — the dialog stays.
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(screen.getByRole("dialog", { name: "Approval for Post to #renewals in Slack" })).toBeTruthy();
  });

  it("2-A: toolkit display names are proper-cased", () => {
    expect(toolkitDisplayName("slack")).toBe("Slack");
    expect(toolkitDisplayName("gmail")).toBe("Gmail");
    expect(toolkitDisplayName("google_calendar")).toBe("Google Calendar");
    expect(toolkitDisplayName("azure-devops")).toBe("Azure Devops");
  });

  it("2-A: the host's catalog label wins over the capitalized toolkit", () => {
    render(
      <VendoProvider client={client} connectors={[{ toolkit: "gmail", label: "Google Mail" }]}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} />
      </VendoProvider>,
    );
    expect(screen.getByRole("button", { name: "Connect Google Mail" })).toBeTruthy();
  });

  it("7-A: a running run swaps the state line to step N/M and puts the runner on the arrow", async () => {
    wire.state.automations[0]!.app.trigger = {
      on: { kind: "host-event", event: "invoice.created" },
      run: { kind: "steps", steps: [{ id: "load", tool: "host_invoices_list" }, { id: "send", tool: "host_email_send" }] },
    };
    wire.state.runs = [{
      id: "run_live",
      appId: "app_auto",
      trigger: { kind: "host-event", event: "invoice.created" },
      status: "running",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      steps: [{ id: "load", tool: "host_invoices_list", outcome: "ok", at: new Date().toISOString() }],
    }];
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    await waitFor(() => expect(screen.getByText(/running now · step 2\/2/)).toBeTruthy());
    expect(document.querySelector(".fl-auto-runner")).not.toBeNull();
  });

  it("7-A: an enabled schedule carries the next-run countdown in the state line", async () => {
    wire.state.automations[0]!.enabled = true;
    wire.state.automations[0]!.app.trigger = {
      on: { kind: "schedule", every: "6h" },
      run: { kind: "steps", steps: [{ id: "load", tool: "host_invoices_list" }] },
    };
    wire.state.runs = [{
      id: "run_done",
      appId: "app_auto",
      trigger: { kind: "schedule" },
      status: "ok",
      startedAt: new Date(Date.now() - 30.5 * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      steps: [],
    }];
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    await waitFor(() => expect(screen.getByText(/next run in 5 h (29|30) m/)).toBeTruthy());
    expect(document.querySelector(".fl-auto-runner")).toBeNull();
  });

  it("4-C: the morph docks into the activity anchor and fires the bump event", () => {
    vi.useFakeTimers();
    const anchor = document.createElement("button");
    anchor.setAttribute(ACTIVITY_ANCHOR_ATTRIBUTE, "");
    anchor.getBoundingClientRect = () => ({
      top: 10, left: 500, width: 60, height: 30, right: 560, bottom: 40, x: 500, y: 10, toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(anchor);
    const onBump = vi.fn();
    window.addEventListener(ACTIVITY_BUMP_EVENT, onBump);
    const onDone = vi.fn();
    try {
      render(
        <MorphToast
          startRect={{ top: 100, left: 20, width: 400, height: 200 }}
          title="Post to #renewals in Slack — approved"
          sub="Posts to #renewals as you"
          theme={{
            colors: { background: "#fff", surface: "#f7f7f8", text: "#111", muted: "#666", accent: "#111", accentText: "#fff", danger: "#c00", border: "#eee" },
            typography: { fontFamily: "system-ui", baseSize: "15px" },
            radius: { small: "6px", medium: "10px", large: "16px" },
            density: "comfortable",
            motion: "full",
          }}
          onDone={onDone}
        />,
      );
      // travel (640ms, or 0 reduced) + shortened dock hold (1400ms) + bump (480ms)
      vi.advanceTimersByTime(640 + 1400 + 480 + 10);
      expect(onBump).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(ACTIVITY_BUMP_EVENT, onBump);
      anchor.remove();
    }
  });

  it("4-C: without an anchor the morph keeps the original hold-and-fade", () => {
    vi.useFakeTimers();
    const onBump = vi.fn();
    window.addEventListener(ACTIVITY_BUMP_EVENT, onBump);
    const onDone = vi.fn();
    try {
      render(
        <MorphToast
          startRect={{ top: 100, left: 20, width: 400, height: 200 }}
          title="Post to #renewals in Slack — approved"
          theme={{
            colors: { background: "#fff", surface: "#f7f7f8", text: "#111", muted: "#666", accent: "#111", accentText: "#fff", danger: "#c00", border: "#eee" },
            typography: { fontFamily: "system-ui", baseSize: "15px" },
            radius: { small: "6px", medium: "10px", large: "16px" },
            density: "comfortable",
            motion: "full",
          }}
          onDone={onDone}
        />,
      );
      vi.advanceTimersByTime(640 + 3200 + 460 + 10);
      expect(onBump).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(ACTIVITY_BUMP_EVENT, onBump);
    }
  });
});
