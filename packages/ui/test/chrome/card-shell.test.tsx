// @vitest-environment jsdom
/**
 * spec §16 — the card shell's three laws, asserted through the REAL card
 * components (the audit's root finding was that no designed reference existed,
 * so nothing we gate on could see a card at all).
 *
 * 1. Ancestors size the shell, never undress it — every card kind renders ONE
 *    `.fl-cardshell` with the same head/line/actions vocabulary.
 * 2. ONE icon well (`.fl-card-ic`, 28px), ONE primary and ONE ceremony button.
 * 3. The plain-words line is mandatory: every kind renders `.fl-card-line`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRequest } from "@vendoai/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import {
  AdoptionCard,
  ApprovalCard,
  AutomationCard,
  ConnectCard,
  GrantSetCard,
  NoPolicyNotice,
  WaitingQueue,
} from "../../src/chrome/index.js";
import { CARD_EYEBROWS } from "../../src/chrome/card-shell.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { createWireServer } from "../wire-server.js";

const approval: ApprovalRequest = {
  id: "apr_shell",
  call: { id: "call_shell", tool: "slack_SLACK_SEND_MESSAGE", args: { channel: "#ops", note: "ship it" } },
  descriptor: { name: "slack_SLACK_SEND_MESSAGE", description: "Post a message.", inputSchema: {}, risk: "write" },
  inputPreview: "slack_SLACK_SEND_MESSAGE {\"channel\":\"#ops\"}",
  ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
  createdAt: "2026-08-03T12:00:00.000Z",
};

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

const provider = (node: React.ReactNode) => <VendoProvider client={client}>{node}</VendoProvider>;

/** Every card kind, as a host actually mounts it. */
const KINDS: Array<[string, React.ReactNode]> = [
  ["approval", <ApprovalCard approval={approval} onDecide={() => undefined} />],
  [
    "standing access",
    <GrantSetCard
      name="Invoice watcher"
      permissions={[{ approvalId: "apr_1", tool: "host_email_send", description: "Send digests.", risk: "read" }]}
      state="parked"
    />,
  ],
  ["connect", <ConnectCard connector="composio" toolkit="slack" message="Connect Slack to post." onConnected={() => undefined} />],
  [
    "paused adoption",
    <AdoptionCard
      card={{
        appId: "app_1",
        automation: "Weekly sweep",
        reason: "departure",
        sponsor: "Dana",
        needs: [{ tool: "host_invoices_list", title: "List invoices", risk: "read" }],
      }}
    />,
  ],
  ["automation", <AutomationCard name="Low balance alert" enabled description="Emails you when checking dips." />],
];

describe("one card shell, three laws", () => {
  it("renders every card kind as ONE shell with a head, a plain-words line and no bespoke geometry", () => {
    for (const [kind, node] of KINDS) {
      const view = render(provider(node));
      const shells = view.container.querySelectorAll(".fl-cardshell");
      expect(shells, kind).toHaveLength(1);
      const shell = shells[0]!;
      expect(shell.tagName, kind).toBe("ARTICLE");
      expect(shell.getAttribute("aria-label"), kind).toBeTruthy();
      // Law 3 — it always says what it does.
      expect(shell.querySelectorAll(".fl-card-line").length, kind).toBeGreaterThanOrEqual(1);
      // Law 2 — one icon well, one size, on every kind.
      expect(shell.querySelectorAll(".fl-card-ic"), kind).not.toHaveLength(0);
      expect(shell.querySelector(".fl-card-eyebrow")?.textContent, kind).toBeTruthy();
      expect(shell.querySelector(".fl-card-title")?.textContent, kind).toBeTruthy();
      // The three retired bodies: no card picks a raw <pre> any more.
      expect(shell.querySelector("pre"), kind).toBeNull();
      cleanup();
    }
  });

  it("dresses a destructive ask in the ceremony register with the ONE ceremony button", () => {
    render(provider(
      <ApprovalCard
        approval={{ ...approval, descriptor: { ...approval.descriptor, risk: "destructive" } }}
        onDecide={() => undefined}
      />,
    ));
    const shell = document.querySelector(".fl-cardshell")!;
    expect(shell.classList.contains("fl-cardshell--ceremony")).toBe(true);
    expect(screen.getByRole("button", { name: "Approve" }).classList.contains("fl-btn-ceremony")).toBe(true);
    // One ceremony name only — the .fl-btn-critical alias is retired, markup
    // and stylesheet (its dead token is pinned by theme-tokens.test.tsx).
    expect(document.querySelector(".fl-btn-critical")).toBeNull();
    expect(CHROME_CSS).not.toMatch(/\.fl-btn-critical\s*[,{:]/);
  });

  it("keeps one icon-well size and one primary-button style in the sheet itself", () => {
    // Law 2, at the source: the shell owns 28px, and the only other well sizes
    // left in the stylesheet belong to non-card furniture (rows, docks, pills).
    expect(CHROME_CSS).toContain(".fl-card-ic { display: grid; place-items: center; width: 28px; height: 28px;");
    // Law 1: the ancestors that touch a shell may only size it.
    const ancestorRules = CHROME_CSS.split("\n").filter(line => /\.fl-\S+ (?:>\s*)?\.fl-cardshell/.test(line));
    expect(ancestorRules.length).toBeGreaterThan(0);
    for (const rule of ancestorRules) {
      expect(rule).not.toMatch(/padding|border(?!-)|background|box-shadow/);
    }
  });

  it("M31 — announces a raised ask through a region that was mounted before it", async () => {
    const view = render(provider(<WaitingQueue pollMs={0} />));
    // The live region exists independent of the strip, so its text CHANGES
    // (which is what a screen reader announces) rather than appearing with its
    // content, which is announced by nothing.
    const region = view.container.querySelector('[role="status"]')!;
    expect(region).not.toBeNull();
    await waitFor(() => expect(region.textContent).toBe("1 thing needs you."));
    expect(region.className).toContain("fl-sr-only");
  });

  it("expands the count-first waiting strip in place and clears when the queue empties", async () => {
    const view = render(provider(<WaitingQueue pollMs={0} />));
    const strip = await waitFor(() => {
      const found = view.container.querySelector("details.fl-waiting-strip");
      expect(found).not.toBeNull();
      return found!;
    });
    // Count first, collapsed, and the cards are the same shell underneath.
    expect(strip.hasAttribute("open")).toBe(false);
    expect(strip.querySelector("summary")?.textContent).toBe(`${CARD_EYEBROWS.waiting} · 1`);
    expect(strip.querySelector(".fl-cardshell")).not.toBeNull();
    // The row says what KIND of ask it is; the summary carries the count.
    expect(strip.querySelector(".fl-card-eyebrow")?.textContent).toBe(CARD_EYEBROWS.approval);
  });

  it("never renders a refusal's developer sentence — the consumer-voice law", () => {
    // §16.3: every sentence the wire throws is written for the host developer
    // (one names an env var, another carries an app id). A card shows what it
    // means for the PERSON — `refusalCopy` in adoption-card is the pattern.
    // This is a source grep, so it proves the shape the audit caught is gone,
    // not that every string is consumer-voiced.
    const CARDS = /^(approval-card|approval-sheet|adoption-card|automation-card|connect-card|grant-set-card|embeds|waiting-queue|card-shell|morph-toast)\.tsx$/;
    const files = [
      ...readdirSync("src/chrome").filter(name => CARDS.test(name)).map(name => join("src/chrome", name)),
      join("src/voice", "voice-consent.tsx"),
      // Added at integration: the slot is the most PUBLIC surface we have (it
      // sits on the host's own page) and it rendered `reason.message` verbatim.
      join("src/chrome", "vendo-slot.tsx"),
    ];
    const offenders = files.filter(file =>
      /\{\s*(?:\w+\.)*reason\.message\s*\}/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("never prepends the developer policy banner above a consent card", async () => {
    wire.state.posture = "unconfigured";
    for (const [kind, node] of KINDS) {
      // NoPolicyNotice is the control: waiting for ITS banner proves the
      // unconfigured posture is live, so a card that shows none is opting out
      // rather than racing the probe.
      render(provider(<><NoPolicyNotice />{node}</>));
      const banner = await screen.findByRole("region", { name: "Vendo is running without a policy" });
      expect(screen.getAllByRole("region", { name: "Vendo is running without a policy" }), kind).toHaveLength(1);
      // And it is not inside the card's own chrome boundary.
      expect(banner.closest(".vendo-root")?.querySelector(".fl-cardshell"), kind).toBeNull();
      cleanup();
    }
  });
});
