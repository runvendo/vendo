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
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import {
  ApprovalCard,
  AutomationCard,
  ConnectCard,
  GrantSetCard,
  NoPolicyNotice,
} from "../../src/chrome/index.js";
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
/** ⚠️ TEST EDIT (M1 · Sentence, then C2 + A1): the SENTENCE FAMILY has no HEAD.
    Each of these cards is its own first line — the approval's question, the
    connect row's toolkit name, the automation's rule — so none wears an eyebrow
    or a title, and law 2's ONE-well rule is asserted over the kinds that still
    have a head. Connect does show a mark, deliberately NOT in the well: the
    28px well's radius and fill cropped the Gmail M (connect.test.tsx pins the
    raw mark). Law 1 (one shell, no bespoke geometry) and law 3 (it always says
    what it does) still cover every kind, headless ones included. */
const HEADLESS = new Set(["approval", "connect", "automation"]);

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
      if (!HEADLESS.has(kind)) {
        // Law 2 — one icon well, one size, on every kind that has a head.
        expect(shell.querySelectorAll(".fl-card-ic"), kind).not.toHaveLength(0);
        expect(shell.querySelector(".fl-card-eyebrow")?.textContent, kind).toBeTruthy();
        expect(shell.querySelector(".fl-card-title")?.textContent, kind).toBeTruthy();
      }
      // The three retired bodies: no card picks a raw <pre> any more.
      expect(shell.querySelector("pre"), kind).toBeNull();
      cleanup();
    }
  });

  it("carries a destructive ask in plain words, with no amber and one filled button", () => {
    // ⚠️ TEST EDIT (M1 · Sentence): this pinned the amber ceremony register on a
    // destructive approval. The approved design carries irreversibility in
    // WORDS on the quiet line ("Can't be undone") and keeps the card neutral —
    // there is no amber anywhere on it, and Approve is the host's own accent
    // fill. The ceremony register stays the SHELL's vocabulary; no card uses it.
    render(provider(
      <ApprovalCard
        approval={{ ...approval, descriptor: { ...approval.descriptor, risk: "destructive" } }}
        onDecide={() => undefined}
      />,
    ));
    const shell = document.querySelector(".fl-cardshell")!;
    expect(shell.classList.contains("fl-cardshell--ceremony")).toBe(false);
    expect(shell.querySelector(".fl-approval-sub")!.textContent).toContain("can’t undo");
    expect(screen.getByRole("button", { name: "Approve" }).classList.contains("fl-btn-primary")).toBe(true);
    expect(document.querySelector(".fl-btn-ceremony")).toBeNull();
    // One ceremony name only — the .fl-btn-critical alias is retired, markup
    // and stylesheet (its dead token is pinned by theme-tokens.test.tsx).
    expect(document.querySelector(".fl-btn-critical")).toBeNull();
    expect(CHROME_CSS).not.toMatch(/\.fl-btn-critical\s*[,{:]/);
  });

  it("keeps one icon-well size and one primary-button style in the sheet itself", () => {
    // Law 2, at the source: the shell owns ONE well size, 28px, and the cards
    // that kept a head use it. The sentence family's cards have no well at all;
    // where they show a brand's logo they show it raw (`.fl-mark-raw`, 26px, no
    // fill and no radius), because a well is drawn for a glyph and cropped the
    // real marks — see connect.test.tsx and approval-degraded.test.tsx.
    expect(CHROME_CSS).toContain(".fl-card-ic { display: grid; place-items: center; width: 28px; height: 28px;");
    // Law 1: the ancestors that touch a shell may only size it.
    const ancestorRules = CHROME_CSS.split("\n").filter(line => /\.fl-\S+ (?:>\s*)?\.fl-cardshell/.test(line));
    expect(ancestorRules.length).toBeGreaterThan(0);
    for (const rule of ancestorRules) {
      expect(rule).not.toMatch(/padding|border(?!-)|background|box-shadow/);
    }
  });

  it("never renders a refusal's developer sentence — the consumer-voice law", () => {
    // §16.3: every sentence the wire throws is written for the host developer
    // (one names an env var, another carries an app id). A card shows what it
    // means for the PERSON — `refusalCopy` in grant-set-card is the pattern.
    // This is a source grep, so it proves the shape the audit caught is gone,
    // not that every string is consumer-voiced.
    const CARDS = /^(approval-card|approval-sheet|automation-card|connect-card|grant-set-card|embeds|card-shell|morph-toast)\.tsx$/;
    const files = [
      ...readdirSync("src/chrome").filter(name => CARDS.test(name)).map(name => join("src/chrome", name)),
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
