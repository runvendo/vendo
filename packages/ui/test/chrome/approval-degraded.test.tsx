// @vitest-environment jsdom
/**
 * spec §16 — THE regression suite for the card audit: every degraded-data case
 * that made the "same" card look like a different product, through the REAL
 * components.
 *
 * empty schema · nested args · >8 fields · connector slug names · logo 404 ·
 * missing ToolMeta — plus the defect that started it: an in-thread $47.50
 * reading as "4750 (unit not specified)" because the thread synthesized
 * `inputSchema: {}` instead of carrying the descriptor.
 */
import type { ApprovalRequest, JsonSchema } from "@vendoai/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type ToolMetaMap, type VendoClient } from "../../src/index.js";
import { ApprovalCard, GrantSetCard } from "../../src/chrome/index.js";
import { CardFields } from "../../src/chrome/card-shell.js";
import { venuePhrase } from "../../src/chrome/approval-card.js";
import { fieldRows } from "../../src/chrome/field-rows.js";
import { buildApprovalRequest } from "../../src/chrome/thread/approval-wire.js";
import { createWireServer } from "../wire-server.js";

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

function ask(over: Partial<ApprovalRequest> & { args?: unknown; inputSchema?: JsonSchema }): ApprovalRequest {
  const { args, inputSchema, ...rest } = over;
  return {
    id: "apr_deg",
    call: { id: "call_deg", tool: "host_thing_do", args: (args ?? {}) as never },
    descriptor: { name: "host_thing_do", description: "", inputSchema: inputSchema ?? {}, risk: "write" },
    inputPreview: "host_thing_do {\"a\":1}",
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
    createdAt: "2026-08-03T12:00:00.000Z",
    ...rest,
  } as ApprovalRequest;
}

const show = (approval: ApprovalRequest, tools?: ToolMetaMap) =>
  render(
    <VendoProvider client={client} {...(tools === undefined ? {} : { tools })}>
      <ApprovalCard approval={approval} onDecide={() => undefined} />
    </VendoProvider>,
  ).container;

/** ⚠️ TEST EDIT (M1 · Sentence), applied throughout this file: the card's field
    TABLE is gone. Every real input is still displayed and still formatted by the
    same seam — as `Label: value` notes on the one quiet line under the question,
    visible by default. `rowsOf` reads those notes; the input-formatting
    expectations below are byte-for-byte the ones the table carried. */
const rowsOf = (container: HTMLElement): Array<[string, string]> => {
  // The input notes are the LEADING run of the list — `consentAsk` emits every
  // remaining row first, then what approving does. Taking the leading run
  // rather than scanning for ": " anywhere means a consequence sentence can
  // never be counted as an input (nor an input skipped because the sentence
  // above it happened to carry a colon).
  const rows: Array<[string, string]> = [];
  for (const note of notesOf(container)) {
    const at = note.indexOf(": ");
    if (at < 0) break;
    rows.push([note.slice(0, at), note.slice(at + 2)]);
  }
  return rows;
};

/** One note per list item, in order — the exact set, with no split heuristic.
    ⚠️ TEST EDIT (clipboard separator): the " · " is real text leading every item
    but the first now (it has to be in the text to be copyable), and it is
    stripped here rather than written into every expectation below — `rowsOf`
    reads a LABEL off the front of each note, and " · Tags" is not a label this
    card renders. `approval-notes-copy.test.tsx` owns the separator itself, in
    both directions; a doubled one would survive this strip and fail these. */
const notesOf = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll(".fl-approval-sub li"))
    .map(li => li.textContent!.replace(/^ · /, ""));

describe("degraded data never changes the card", () => {
  it("keeps the mandatory line with an empty schema, no description and no host metadata", () => {
    const container = show(ask({ args: { note: "hi" } }));
    // Law 3 — no described tool still gets a sentence, not a blank card. With
    // nothing to synthesize a question from, the ask asks with its own
    // humanized label (what the card's title always read) and the consequence
    // CLASS says what approving DOES — that half still never names the tool.
    expect(container.querySelector(".fl-approval-ask")!.textContent).toBe("Thing do?");
    expect(notesOf(container)).toContain("This changes something in your account, and it runs as you.");
    expect(rowsOf(container)).toEqual([["Note", "hi"]]);
    // The prettified id, never the raw slug (ENG-216).
    expect(screen.queryByText("host_thing_do")).toBeNull();
  });

  it("flattens nested args into readable lines instead of falling back to raw JSON", () => {
    const container = show(ask({
      args: { recipient: { name: "Acme", id: "cus_7" }, tags: ["urgent", "ops"] },
    }));
    expect(container.querySelector("pre")).toBeNull();
    expect(rowsOf(container)).toEqual([
      ["Recipient", "Name: Acme\nId: cus_7"],
      ["Tags", "urgent\nops"],
    ]);
  });

  it("renders MORE than eight fields as rows — the old 9th arg dumped raw JSON", () => {
    const args = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field_${index}`, `v${index}`]));
    const container = show(ask({ args }));
    expect(container.querySelector("pre")).toBeNull();
    expect(rowsOf(container)).toHaveLength(12);
    expect(container.querySelector(".fl-approval-sub")!.textContent).not.toContain("{");
  });

  it("brands a connector ask by its toolkit and survives a logo 404", () => {
    // ⚠️ TEST EDIT (M1 · Sentence, then C2): the approval card has no icon well
    // any more — the question is the whole card — so the toolkit mark and its
    // 404 fallback are asserted on the standing-access card's permission rows,
    // which still carry a mark. That mark is now RAW (`.fl-mark-raw`, shared
    // with the connect row): it is the same remote logo, and the 28px well's
    // radius and fill cropped it. The fallback contract is unchanged — a glyph,
    // never an empty box — and the raw box sizes it.
    const grants = render(
      <VendoProvider client={client}>
        <GrantSetCard
          name="Renewal digest"
          permissions={[{ approvalId: "apr_1", tool: "slack_SLACK_SEND_MESSAGE", risk: "write" }]}
          state="parked"
        />
      </VendoProvider>,
    ).container;
    const mark = grants.querySelector(".fl-grant .fl-mark-raw")!;
    // Nothing crops a brand's logo on this card either: a row WITH a logo wears
    // the raw mark. (A host tool has no logo, so its glyph keeps the well it was
    // drawn for — asserted below.)
    expect(grants.querySelector(".fl-grant .fl-card-ic")).toBeNull();
    const logo = mark.querySelector("img")!;
    expect(logo.getAttribute("src")).toContain("logos.composio.dev");
    // The CDN fails (unknown slug, offline, blocked): the mark keeps a glyph
    // rather than an empty box — three of the four call sites had no onError.
    fireEvent.error(logo);
    expect(mark.querySelector("img")).toBeNull();
    expect(mark.querySelector("svg")).not.toBeNull();
    cleanup();

    // A HOST tool has no brand mark to show raw, so its glyph keeps the 28px
    // well — the shape a glyph was drawn for, and law 2's one well size.
    const hostRow = render(
      <VendoProvider client={client}>
        <GrantSetCard
          name="Low balance alert"
          permissions={[{ approvalId: "apr_2", tool: "host_listAccounts", risk: "read" }]}
          state="parked"
        />
      </VendoProvider>,
    ).container;
    expect(hostRow.querySelector(".fl-grant .fl-mark-raw")).toBeNull();
    expect(hostRow.querySelector(".fl-grant .fl-card-ic svg")).not.toBeNull();
    cleanup();

    // The slug never reads as the ask.
    const container = show(ask({
      call: { id: "call_slack", tool: "slack_SLACK_SEND_MESSAGE", args: { channel: "#ops" } },
      descriptor: { name: "slack_SLACK_SEND_MESSAGE", description: "", inputSchema: {}, risk: "write" },
    }));
    expect(screen.queryByText("slack_SLACK_SEND_MESSAGE")).toBeNull();
    expect(container.querySelector(".fl-approval-ask")!.textContent).toBe("Slack send message?");
  });

  it("prefers host ToolMeta when it exists and degrades cleanly when it does not", () => {
    const withMeta = show(ask({ args: { amount: 12 } }), {
      host_thing_do: { label: "Do the thing", description: "Runs the thing once." },
    });
    expect(withMeta.querySelector(".fl-approval-ask")!.textContent).toBe("Do the thing?");
    expect(notesOf(withMeta)).toContain("Runs the thing once.");
    cleanup();
    const without = show(ask({ args: { amount: 12 } }));
    expect(without.querySelector(".fl-approval-ask")!.textContent).toBe("Thing do?");
  });

  it("formats an undeclared number honestly and a declared one as money", () => {
    const undeclared = show(ask({ args: { amount: 4750 } }));
    expect(rowsOf(undeclared)).toEqual([["Amount", "4750 (unit not specified)"]]);
    cleanup();
    const declared = show(ask({
      args: { amount: 4750 },
      inputSchema: { type: "object", properties: { amount: { type: "integer", description: "Amount in integer cents" } } },
    }));
    expect(rowsOf(declared)).toEqual([["Amount", "$47.50"]]);
  });

  it("bounds a huge single argument instead of pouring it into the card", () => {
    const rows = fieldRows({ blob: "x".repeat(5_000) });
    expect(rows[0]!.value.length).toBeLessThan(500);
    expect(rows[0]!.value.endsWith("…")).toBe(true);
  });
});

describe("a boolean field is an answer, never the literal", () => {
  it("reads true/false as Yes/No on the card, whatever the key means", () => {
    const container = show(ask({ args: { invoiceId: "inv_42", permanent: true, notifyOwner: false } }));
    expect(rowsOf(container)).toEqual([
      ["Invoice id", "inv_42"],
      // The key carries the meaning ("Permanent") — the VALUE stays Yes/No.
      ["Permanent", "Yes"],
      ["Notify owner", "No"],
    ]);
    expect(container.querySelector(".fl-approval-sub")!.textContent).not.toContain("true");
    expect(container.querySelector(".fl-approval-sub")!.textContent).not.toContain("false");
  });

  it("keeps the raw literal for dev mode, on the dd tooltip", () => {
    const rows = fieldRows({ permanent: true, notifyOwner: false });
    expect(rows.map(row => [row.value, row.raw])).toEqual([["Yes", "true"], ["No", "false"]]);
    // ⚠️ TEST EDIT (L37): the tooltip used to render for EVERYONE — the test
    // name always said "for dev mode", and now the code agrees. A `title` is an
    // end-user surface (it put raw JSON and developer literals one hover from a
    // bank customer, invisible to every audit because the law excluded `title`).
    //
    // ⚠️ TEST EDIT (M1 · Sentence): asserted against `CardFields` itself now.
    // The approval card renders its inputs as plain notes, so the dd — and the
    // tooltip this law is about — lives only on the cards that still use rows.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const dev = render(<CardFields rows={rows} />).container;
      expect(dev.querySelector(".fl-card-field dd")!.getAttribute("title")).toBe("true");
    } finally {
      process.env.NODE_ENV = previous;
    }
    cleanup();
    expect(render(<CardFields rows={rows} />).container.querySelector(".fl-card-field dd")!.getAttribute("title")).toBeNull();
    cleanup();
    // The honesty contract lives in the DISPLAY, which always shows every input.
    expect(rowsOf(show(ask({ args: { permanent: true } })))).toEqual([["Permanent", "Yes"]]);
  });

  it("reads a declared boolean and a NESTED boolean the same way", () => {
    const declared = show(ask({
      args: { permanent: true },
      inputSchema: { type: "object", properties: { permanent: { type: "boolean" } } },
    }));
    expect(rowsOf(declared)).toEqual([["Permanent", "Yes"]]);
    expect(fieldRows({ options: { permanent: true, dryRun: false } })[0]!.value)
      .toBe("Permanent: Yes\nDry run: No");
    expect(fieldRows({ flags: [true, false] })[0]!.value).toBe("Yes\nNo");
  });
});

describe("the plain-words line says what happens, not which tool", () => {
  const money = (over: { critical?: boolean; schema?: boolean; meta?: boolean } = {}) => ask({
    call: {
      id: "call_send",
      tool: "host_transferMoney",
      args: { amount: 4750, recipient_name: "Acme Utilities", memo: "July water bill" },
    },
    descriptor: {
      name: "host_transferMoney",
      title: "Send money",
      description: "",
      inputSchema: over.schema === false
        ? {}
        : { type: "object", properties: { amount: { type: "integer", description: "Amount in integer cents" } } },
      risk: over.critical === false ? "write" : "destructive",
    },
  } as Partial<ApprovalRequest>);

  /** ⚠️ TEST EDIT (M1 · Sentence) throughout this block: the ONE plain-words
      line became a PAIR — the question (`.fl-approval-ask`) and the quiet notes
      under it. The question names the action and its key values; the notes say
      what approving DOES. Every expectation below moved to whichever half now
      carries it; the ladder itself is unchanged. */
  const question = (container: HTMLElement): string =>
    container.querySelector(".fl-approval-ask")!.textContent!;
  const does = (container: HTMLElement): string => notesOf(container).join(" · ");

  it("tier 1 — the host's own description wins over anything synthesized", () => {
    const container = show(money(), {
      host_transferMoney: { label: "Send money", description: "Pays your water bill from checking." },
    });
    expect(notesOf(container)).toContain("Pays your water bill from checking.");
  });

  it("tier 2 — synthesizes one truthful question from the REAL inputs", () => {
    const container = show(money());
    expect(question(container)).toBe("Send $47.50 to Acme Utilities?");
    // …and the destructive grade says so in plain words, with no amber and no
    // pill to carry it.
    expect(notesOf(container)).toContain("Sends now, as you");
    expect(notesOf(container)).toContain("Can’t be undone");
    // Every input is still in plain sight: the two the question names, plus the
    // memo on the quiet line. Nothing folds anywhere on this card any more.
    expect(rowsOf(container)).toEqual([["Memo", "July water bill"]]);
    expect(container.querySelector(".fl-approval-details")).toBeNull();
  });

  it("tier 2 — works off the host's field formatter when no schema rides along", () => {
    // The live in-thread case: `inputSchema: {}`, money declared only by the
    // host's ToolMeta formatter (Maple's own approval card).
    const container = show(money({ schema: false }), {
      host_transferMoney: { label: "Send money", formatField: (key, value) => key === "amount" && typeof value === "number" ? `$${(value / 100).toFixed(2)}` : undefined },
    });
    expect(question(container)).toBe("Send $47.50 to Acme Utilities?");
  });

  it("tier 3 — falls back to the consequence CLASS, never the tool name", () => {
    // Nothing to synthesize from: no description, no declared money.
    const bare = show(money({ schema: false }));
    // The GRADE says what it does, not the name (Yousef's D1). This read "This
    // moves money, as you." only because the tool id contains "transfer".
    expect(notesOf(bare)).toContain("This makes a change you can’t undo, and it runs as you.");
    expect(does(bare)).not.toContain("Send money");
    expect(does(bare)).not.toContain("Vendo will run");
    cleanup();
    // A tool whose words name no known verb still never reads its own label
    // back at the person on the what-it-DOES half: the risk class carries it.
    const unknown = show(ask({ args: { note: "hi" } }));
    expect(notesOf(unknown)).toContain("This changes something in your account, and it runs as you.");
    expect(does(unknown)).not.toContain("Thing do");
  });

  it("C5 — two declared money fields synthesize NO question, and nothing folds", () => {
    // The live shape: a fee beside the amount. The old rule took the FIRST
    // numeric field whose display changed, so this read "Sends $1.99 to Acme
    // Utilities" — the wrong number — and the card then folded the true rows
    // behind Details, hiding the $47.50 the person was actually approving.
    const container = show(ask({
      call: {
        id: "call_send",
        tool: "host_transferMoney",
        args: { fee_cents: 199, amount_cents: 4750, recipient_name: "Acme Utilities" },
      },
      descriptor: { name: "host_transferMoney", title: "Send money", description: "", inputSchema: {}, risk: "write" },
    } as Partial<ApprovalRequest>));
    expect(question(container)).toBe("Send money?");
    expect(question(container)).not.toContain("$1.99");
    expect(notesOf(container)).toContain("This changes something in your account, and it runs as you.");
    // Never fold on uncertainty: both amounts stay in plain sight.
    expect(container.querySelector(".fl-approval-details")).toBeNull();
    expect(rowsOf(container)).toEqual([
      ["Fee cents", "$1.99"],
      ["Amount cents", "$47.50"],
      ["Recipient name", "Acme Utilities"],
    ]);
  });

  it("C5 — a host formatter that formats a RATE is not a money declaration", () => {
    const container = show(
      ask({
        call: {
          id: "call_send",
          tool: "host_transferMoney",
          args: { rate: 5, recipient_name: "Acme Utilities" },
        },
        descriptor: { name: "host_transferMoney", title: "Send money", description: "", inputSchema: {}, risk: "write" },
      } as Partial<ApprovalRequest>),
      { host_transferMoney: { formatField: (key, value) => key === "rate" ? `${String(value)}%` : undefined } },
    );
    // "Send 5% to Acme Utilities?" was a real possible question here.
    expect(question(container)).toBe("Send money?");
    expect(notesOf(container)).toContain("This changes something in your account, and it runs as you.");
    expect(rowsOf(container)).toEqual([["Rate", "5%"], ["Recipient name", "Acme Utilities"]]);
  });

  it("H-7 — money NESTED in the args blocks the question and the fold", () => {
    // `moneyValue` counted top-level fields only, while `field-rows`' `display`
    // formats money at any depth. So this read "Sends $47.50 to Acme
    // Utilities — now, as you." and then folded the rows behind Details,
    // putting the $25.00 tip the person was also approving one disclosure away
    // under a sentence that never mentioned it.
    const container = show(ask({
      call: {
        id: "call_send",
        tool: "host_transferMoney",
        args: { amount_cents: 4750, recipient_name: "Acme Utilities", extras: { tip_cents: 2500 } },
      },
      descriptor: { name: "host_transferMoney", title: "Send money", description: "", inputSchema: {}, risk: "write" },
    } as Partial<ApprovalRequest>));
    expect(question(container)).toBe("Send money?");
    expect(notesOf(container)).toContain("This changes something in your account, and it runs as you.");
    // Both amounts stay in plain sight, formatted, with nothing folded.
    expect(container.querySelector(".fl-approval-details")).toBeNull();
    expect(rowsOf(container)).toEqual([
      ["Amount cents", "$47.50"],
      ["Recipient name", "Acme Utilities"],
      ["Extras", "Tip cents: $25.00"],
    ]);
  });

  it("H-7 — a NESTED amount earns no question, and prints exactly once", () => {
    // ⚠️ TEST EDIT (review of #1149): this asserted only the question, so it
    // could not see that the SAME $18.50 also printed as a note — the question
    // consumed the leaf key `amount_cents`, which matches no row (the row is
    // "Charge"). A nested amount owns no row of its own, so dropping "its" row
    // would take its siblings dark; it earns no question instead, and the rows
    // stay in sight exactly once each.
    const container = show(ask({
      call: {
        id: "call_send",
        tool: "host_transferMoney",
        args: { charge: { amount_cents: 1850 }, recipient_name: "Acme Utilities" },
      },
      descriptor: { name: "host_transferMoney", title: "Send money", description: "", inputSchema: {}, risk: "write" },
    } as Partial<ApprovalRequest>));
    expect(question(container)).toBe("Send money?");
    expect(rowsOf(container)).toEqual([
      ["Charge", "Amount cents: $18.50"],
      ["Recipient name", "Acme Utilities"],
    ]);
    expect(container.textContent!.split("$18.50")).toHaveLength(2);
  });

  it("a question consumes its inputs by KEY, so a colliding sibling still shows", () => {
    // `humanizeToolName` is many-to-one: `recipient_name` and `recipientName`
    // both read "Recipient name", and the label-based dedupe took Bob Smith off
    // a card that was about to move money.
    const container = show(ask({
      call: {
        id: "call_send",
        tool: "host_transferMoney",
        args: { amount_cents: 4750, recipient_name: "Acme Utilities", recipientName: "Bob Smith" },
      },
      descriptor: { name: "host_transferMoney", title: "Send money", description: "", inputSchema: {}, risk: "write" },
    } as Partial<ApprovalRequest>));
    expect(question(container)).toBe("Send $47.50 to Acme Utilities?");
    expect(rowsOf(container)).toEqual([["Recipient name", "Bob Smith"]]);
  });

  it("asks with the host's own display for a value, not the raw one under it", () => {
    // The question interpolated the RAW value while the row carrying the host's
    // formatted one was deduped away, so "Maple Savings" appeared nowhere.
    const container = show(
      ask({
        call: {
          id: "call_send",
          tool: "host_transferMoney",
          args: { amount_cents: 4750, recipient_name: "acct_8820" },
        },
        descriptor: { name: "host_transferMoney", title: "Send money", description: "", inputSchema: {}, risk: "write" },
      } as Partial<ApprovalRequest>),
      { host_transferMoney: { formatField: key => key === "recipient_name" ? "Maple Savings" : undefined } },
    );
    expect(question(container)).toBe("Send $47.50 to Maple Savings?");
  });

  it("an ORDINARY ask hides nothing either — the fold is gone from every grade", () => {
    // ⚠️ TEST EDIT (M1 · Sentence): this pinned the Details fold on a
    // non-critical consequence ask. M1 retired the fold outright — the honesty
    // law is satisfied by SHOWING, and a disclosure is not showing — so the
    // ordinary ask now reads exactly like the destructive one, minus the grade's
    // warning.
    const container = show(money({ critical: false }));
    expect(question(container)).toBe("Send $47.50 to Acme Utilities?");
    expect(container.querySelector(".fl-approval-details")).toBeNull();
    expect(rowsOf(container)).toEqual([["Memo", "July water bill"]]);
    expect(notesOf(container)).not.toContain("Can’t be undone");
  });

  it("UNGRADED says so in plain words and still hides nothing (ruling 15, second half)", () => {
    // The wire graded nothing. Ruling 15 made the DISPLAY grade a write; the
    // card then treated the ask as ordinary — `critical` false — so the
    // consequence sentence folded the real inputs behind Details and the
    // ceremony edge was dropped. Scrutiny must not be reduced on a grade
    // nobody supplied.
    //
    // ⚠️ TEST EDIT (#747): `ungraded` is a first-class RiskLabel now, so the
    // wire carries it as itself instead of the old `write` + `critical: true`
    // approximation.
    //
    // ⚠️ TEST EDIT (M1 · Sentence): the amber ceremony register left this card
    // — there is no amber anywhere on it — so the extra scrutiny is carried by
    // the plain words the grade earns, and by the fact that nothing folds.
    const approval = buildApprovalRequest({
      approvalId: "apr_ungraded",
      toolCallId: "call_ungraded",
      tool: "host_transferMoney",
      args: { amount_cents: 4750, recipient_name: "Acme Utilities" },
    }, {});
    expect(approval.descriptor.risk).toBe("ungraded");
    const container = show(approval);
    expect(question(container)).toBe("Send $47.50 to Acme Utilities?");
    expect(notesOf(container)).toContain("Nobody has checked what this changes");
    expect(container.querySelector(".fl-approval-details")).toBeNull();
    expect(container.querySelector(".fl-cardshell--ceremony")).toBeNull();
    expect(container.querySelector(".fl-btn-ceremony")).toBeNull();
  });

  it("a GRADED ask is untouched — no warning it did not earn", () => {
    const graded = buildApprovalRequest({
      approvalId: "apr_graded",
      toolCallId: "call_graded",
      tool: "host_transferMoney",
      args: { amount_cents: 4750, recipient_name: "Acme Utilities" },
      risk: "write",
    }, {});
    expect(graded.descriptor.confirmEach).toBeUndefined();
    const notes = notesOf(show(graded));
    expect(notes).not.toContain("Nobody has checked what this changes");
    expect(notes).not.toContain("Can’t be undone");
  });
});

/** ⚠️ TEST EDIT (M1 · Sentence): the byline ROW is gone — who asked is one of the
    quiet notes under the question, and "runs as you" is already the agency note
    there, so only the venue phrase itself rides along (`venuePhrase`). The
    never-print-an-id contract is unchanged. */
describe("the venue note never prints an id", () => {
  const inApp = (over: Partial<ApprovalRequest["ctx"]>): ApprovalRequest => ask({
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "app", presence: "present", ...over },
  } as Partial<ApprovalRequest>);

  it("says the bare phrase when the only thing known about the app is its id", () => {
    const container = show(inApp({ appId: "app_1" }));
    const notes = notesOf(container);
    expect(notes.at(-1)).toBe("asked in an app");
    expect(container.textContent).not.toContain("app_1");
  });

  it("uses a human venue name when the surface knows one", () => {
    const { container } = render(
      <VendoProvider client={client}>
        <ApprovalCard approval={inApp({ appId: "app_1" })} onDecide={() => undefined} venueName="Money HQ" />
      </VendoProvider>,
    );
    expect(notesOf(container).at(-1)).toBe("asked in Money HQ");
  });

  it("refuses an id-shaped token from ANY source, and never reads a raw venue slug", () => {
    for (const token of ["app_1", "apr_9", "thr_x", "grt_7", "run_2"]) {
      expect(venuePhrase("app", token)).toBe("asked in an app");
      expect(venuePhrase("automation", token)).toBe("asked by an automation");
    }
    expect(venuePhrase("automation", "Weekly digest")).toBe("asked by Weekly digest");
    // An unknown venue says nothing at all, never its slug.
    expect(venuePhrase("app_1")).toBeUndefined();
    expect(venuePhrase("some-new-venue")).toBeUndefined();
  });
});

describe("the in-thread approval carries the real descriptor", () => {
  it("formats money IN-THREAD once the wire part's schema rides along", () => {
    const part = {
      approvalId: "apr_thread",
      toolCallId: "call_thread",
      tool: "host_transferMoney",
      args: { amount: 4750, recipient_name: "Acme Utilities" },
      risk: "destructive" as const,
      descriptor: {
        title: "Send money",
        description: "Send money from your checking account.",
        inputSchema: {
          type: "object",
          properties: { amount: { type: "integer", description: "Amount in integer cents" } },
        } as JsonSchema,
      },
    };
    const container = show(buildApprovalRequest(part, {}));
    // The wave-1 live proof E2c defect, on the surface it actually happened on.
    // Both inputs are now IN the question — the amount formatted, the raw
    // integer nowhere on the card.
    expect(container.querySelector(".fl-approval-ask")!.textContent)
      .toBe("Send $47.50 to Acme Utilities?");
    expect(container.textContent).not.toContain("4750");
    expect(rowsOf(container)).toEqual([]);
  });

  it("still builds a usable ask when the wire carries no descriptor at all", () => {
    // ⚠️ TEST EDIT (ruling 14): the host's ToolMeta was handed to the BUILDER only
    // and the card was rendered with no provider `tools`, so the sentence reached
    // the card through `descriptor.description`. A descriptor sentence is no
    // longer a rung on the ladder; the host's ToolMeta is, and in production the
    // card reads it from the same provider the builder does (ThreadApprovals
    // passes the context's tools to both). The fixture now does what production
    // does; every other assertion is unchanged.
    const tools = { host_email_send: { description: "Send an email as you." } };
    const approval = buildApprovalRequest(
      { approvalId: "apr_bare", toolCallId: "call_bare", tool: "host_email_send", args: { to: "a@example.com" } },
      tools,
    );
    expect(approval.descriptor.inputSchema).toEqual({});
    // ⚠️ TEST EDIT (ruling 15, then #747): this pinned "read" for an ask the
    // wire never graded — the chip then said "Read-only" about a call we know
    // nothing about. Ruling 15 made it the cautious `write`; #747 gave the
    // state its own name, so it is carried rather than approximated.
    expect(approval.descriptor.risk).toBe("ungraded");
    // Never the server's `tool slug + canonical JSON`.
    expect(approval.inputPreview).toBe("To: a@example.com");
    const container = show(approval, tools);
    expect(notesOf(container)).toContain("Send an email as you.");
  });
});
