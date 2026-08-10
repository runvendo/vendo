// @vitest-environment jsdom
/** ui-lane-cards converged picks: 1-A consequence-first, 1-H approval sheet,
    2-A brand-forward connect, 3-A′ tray marks, 4-C activity dock. */
import type { ApprovalRequest } from "@vendoai/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ApprovalCard, ApprovalSheet, ConnectCard } from "../../src/chrome/index.js";
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

  // A recurring Slack post used to be described as "It runs as you, and you can
  // pause it anytime." Pausing needs a management surface, and `@vendoai/ui`
  // cannot know whether the host mounted one — Maple mounts none, so the library
  // was promising, in the host's voice, something the host could not honour. The
  // sentence keeps every claim that is true on EVERY host and drops the one that
  // depends on a screen (#1014 deleted the only surface that ever backed it).
  it("describes a recurring Slack post without promising a place to pause it", () => {
    const recurring = toolPresentation("slack_SLACK_SEND_MESSAGE", {
      channel: "#renewals",
      text: "Morning digest",
      trigger: "every weekday at 8am",
    });
    expect(recurring.description).toBe(
      "Vendo will post to #renewals on your behalf, every weekday at 8am. It runs as you.",
    );
    // The one-off sibling never carried the promise, and still doesn't.
    expect(toolPresentation("slack_SLACK_SEND_MESSAGE", { channel: "#renewals", text: "Hi" }).description)
      .toBe("Vendo will post to #renewals on your behalf, running as you.");
  });

  /** ⚠️ TEST EDIT (M1 · Sentence): 1-A's structured `consequence` (pre/artifact/
      mid/target/post) existed so the card could BOLD the artifact and target.
      The approved design's question line is uniformly semibold, so the structure
      is gone: `toolPresentation` now yields the question itself plus the agency
      phrase under it. Same inputs, same authority, same truth conditions. */
  it("1-A: synthesizes a question from the real Slack inputs", () => {
    const presentation = toolPresentation("slack_SLACK_SEND_MESSAGE", slackApproval.call.args);
    expect(presentation.question)
      .toBe("Post “Morning digest: 7 renewals in the next 30 days, 2 at risk.” to #renewals?");
    expect(presentation.agency).toBe("Posts now, as you");
    // Unknown toolkits synthesize nothing — the card asks with the tool's label.
    expect(toolPresentation("host_delete_invoice", { invoiceId: "inv_42" }).question).toBeUndefined();
    // Gmail used to synthesize nothing (PR #391 P1) because a sentence naming
    // only `to` would have FOLDED the subject/body/copied recipients out of
    // sight. M1 retired the fold, so it names the recipient and the rest stays
    // visible on the quiet line.
    expect(toolPresentation("gmail_GMAIL_SEND_EMAIL", {
      to: "alice@example.com",
      subject: "Q3 renewals digest",
      body: "Northwind and Contoso renew this month.",
    }).question).toBe("Send an email to alice@example.com?");
  });

  it("1-A: leads with the question and keeps every remaining input in plain sight", () => {
    const { container } = render(<VendoProvider client={client}><ApprovalCard approval={slackApproval} onDecide={() => undefined} /></VendoProvider>);
    expect(container.querySelector(".fl-approval-ask")!.textContent).toContain("#renewals");
    expect(container.querySelector(".fl-approval-ask")!.textContent).toContain("Morning digest");
    // Nothing folds: the fields disclosure is gone from the card entirely.
    expect(container.querySelector("details.fl-approval-details")).toBeNull();
    expect(container.querySelector(".fl-approval-sub")!.textContent).toContain("Posts now, as you");
  });

  it("1-A: a destructive ask reads the same, plus the grade's plain warning", () => {
    const critical: ApprovalRequest = {
      ...slackApproval,
      descriptor: { ...slackApproval.descriptor, risk: "destructive" },
    };
    const { container } = render(<VendoProvider client={client}><ApprovalCard approval={critical} onDecide={() => undefined} /></VendoProvider>);
    expect(container.querySelector(".fl-approval-ask")!.textContent).toContain("#renewals");
    expect(container.querySelector(".fl-approval-sub")!.textContent).toContain("Can’t be undone");
    expect(container.querySelector("details.fl-approval-details")).toBeNull();
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

  it("4-C: a host on theme.motion reduced gets the opacity-only exit, anchor or not", () => {
    // The morph told the DOM one thing and itself another: it wrote
    // data-vendo-motion="reduced" from the theme (which the chrome stylesheet
    // turns into `transition: none`) while its own timings and the dock path
    // still read the OS media query alone. So a reduced-motion host got the
    // travel budget and the dock with every transition stripped — the pill
    // teleported, then vanished into an anchor it never travelled to.
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
      const view = render(
        <MorphToast
          startRect={{ top: 100, left: 20, width: 400, height: 200 }}
          title="Post to #renewals in Slack — approved"
          theme={{
            colors: { background: "#fff", surface: "#f7f7f8", text: "#111", muted: "#666", accent: "#111", accentText: "#fff", danger: "#c00", border: "#eee" },
            typography: { fontFamily: "system-ui", baseSize: "15px" },
            radius: { small: "6px", medium: "10px", large: "16px" },
            density: "comfortable",
            motion: "reduced",
          }}
          onDone={onDone}
        />,
      );
      expect(document.querySelector<HTMLElement>(".fl-morph-card")?.style.transition).toBe("opacity .3s");
      // No travel to wait out, and the dock is not taken: fade hold, then gone.
      vi.advanceTimersByTime(3200 + 460 + 10);
      expect(onBump).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      window.removeEventListener(ACTIVITY_BUMP_EVENT, onBump);
      anchor.remove();
    }
  });
});
