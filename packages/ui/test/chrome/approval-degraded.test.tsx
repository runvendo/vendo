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
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ApprovalCard } from "../../src/chrome/index.js";
import { venueByline } from "../../src/chrome/approval-card.js";
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

const show = (approval: ApprovalRequest, tools?: Record<string, { label?: string; description?: string }>) =>
  render(
    <VendoProvider client={client} {...(tools === undefined ? {} : { tools })}>
      <ApprovalCard approval={approval} onDecide={() => undefined} />
    </VendoProvider>,
  ).container;

const rowsOf = (container: HTMLElement): Array<[string, string]> =>
  [...container.querySelectorAll(".fl-card-field")].map(row => [
    row.querySelector("dt")!.textContent!,
    row.querySelector("dd")!.textContent!,
  ]);

describe("degraded data never changes the card", () => {
  it("keeps the mandatory line with an empty schema, no description and no host metadata", () => {
    const container = show(ask({ args: { note: "hi" } }));
    // Law 3 — no described tool still gets a sentence, not a blank card. It
    // used to pin "Vendo will run Thing do as you." — the tool's label read
    // back at the user; now it is the consequence CLASS.
    expect(container.querySelector(".fl-card-line")!.textContent).toBe("This changes something in your account, as you.");
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
    expect(screen.getByLabelText("Real tool inputs").textContent).not.toContain("{");
  });

  it("brands a connector ask by its toolkit and survives a logo 404", () => {
    const container = show(ask({
      call: { id: "call_slack", tool: "slack_SLACK_SEND_MESSAGE", args: { channel: "#ops" } },
      descriptor: { name: "slack_SLACK_SEND_MESSAGE", description: "", inputSchema: {}, risk: "write" },
    }));
    const well = container.querySelector(".fl-card-ic")!;
    const logo = well.querySelector("img")!;
    expect(logo.getAttribute("src")).toContain("logos.composio.dev");
    // The CDN fails (unknown slug, offline, blocked): the well keeps a glyph
    // rather than an empty box — three of the four call sites had no onError.
    fireEvent.error(logo);
    expect(well.querySelector("img")).toBeNull();
    expect(well.querySelector("svg")).not.toBeNull();
    // The slug never reads as the title.
    expect(screen.queryByText("slack_SLACK_SEND_MESSAGE")).toBeNull();
    expect(container.querySelector(".fl-card-title")!.textContent).toBe("Slack send message");
  });

  it("prefers host ToolMeta when it exists and degrades cleanly when it does not", () => {
    const withMeta = show(ask({ args: { amount: 12 } }), {
      host_thing_do: { label: "Do the thing", description: "Runs the thing once." },
    });
    expect(withMeta.querySelector(".fl-card-title")!.textContent).toBe("Do the thing");
    expect(withMeta.querySelector(".fl-card-line")!.textContent).toBe("Runs the thing once.");
    cleanup();
    const without = show(ask({ args: { amount: 12 } }));
    expect(without.querySelector(".fl-card-title")!.textContent).toBe("Thing do");
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
    expect(screen.getByLabelText("Real tool inputs").textContent).not.toContain("true");
    expect(screen.getByLabelText("Real tool inputs").textContent).not.toContain("false");
  });

  it("keeps the raw literal for dev mode, on the dd tooltip", () => {
    const rows = fieldRows({ permanent: true, notifyOwner: false });
    expect(rows.map(row => [row.value, row.raw])).toEqual([["Yes", "true"], ["No", "false"]]);
    // ⚠️ TEST EDIT (L37): the tooltip used to render for EVERYONE — the test
    // name always said "for dev mode", and now the code agrees. A `title` is an
    // end-user surface (it put raw JSON and developer literals one hover from a
    // bank customer, invisible to every audit because the law excluded `title`).
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const dev = show(ask({ args: { permanent: true } }));
      expect(dev.querySelector(".fl-card-field dd")!.getAttribute("title")).toBe("true");
    } finally {
      process.env.NODE_ENV = previous;
    }
    cleanup();
    const container = show(ask({ args: { permanent: true } }));
    expect(container.querySelector(".fl-card-field dd")!.getAttribute("title")).toBeNull();
    // The honesty contract lives in the ROW, which always shows every input.
    expect(rowsOf(container)).toEqual([["Permanent", "Yes"]]);
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

  const line = (container: HTMLElement): string => container.querySelector(".fl-card-line")!.textContent!;

  it("tier 1 — the host's own description wins over anything synthesized", () => {
    const container = show(money(), {
      host_transferMoney: { label: "Send money", description: "Pays your water bill from checking." },
    });
    expect(line(container)).toBe("Pays your water bill from checking.");
  });

  it("tier 2 — synthesizes one truthful sentence from the REAL inputs", () => {
    const container = show(money());
    expect(line(container)).toBe("Sends $47.50 to Acme Utilities — now, as you.");
    // A destructive ask gets the sentence AND keeps every input in plain sight:
    // the sentence is the meaning, the fold is a separate (non-critical) call.
    expect(container.querySelector(".fl-approval-details")).toBeNull();
    expect(rowsOf(container)).toHaveLength(3);
  });

  it("tier 2 — works off the host's field formatter when no schema rides along", () => {
    // The live in-thread case: `inputSchema: {}`, money declared only by the
    // host's ToolMeta formatter (Maple's own approval card).
    const container = show(money({ schema: false }), {
      host_transferMoney: { label: "Send money", formatField: (key, value) => key === "amount" && typeof value === "number" ? `$${(value / 100).toFixed(2)}` : undefined },
    });
    expect(line(container)).toBe("Sends $47.50 to Acme Utilities — now, as you.");
  });

  it("tier 3 — falls back to the consequence CLASS, never the tool name", () => {
    // Nothing to synthesize from: no description, no declared money.
    const bare = show(money({ schema: false }));
    // The GRADE says it, not the name (Yousef's D1). This read "This moves
    // money, as you." only because the tool id contains "transfer".
    expect(line(bare)).toBe("This makes a change you can’t undo, as you.");
    expect(line(bare)).not.toContain("Send money");
    expect(line(bare)).not.toContain("Vendo will run");
    cleanup();
    // A tool whose words name no known verb still never reads its own label
    // back at the person: the risk class carries the sentence.
    const unknown = show(ask({ args: { note: "hi" } }));
    expect(line(unknown)).toBe("This changes something in your account, as you.");
    expect(line(unknown)).not.toContain("Thing do");
  });

  it("C5 — two declared money fields synthesize NO sentence, and nothing folds", () => {
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
    expect(container.querySelector(".fl-approval-consequence-line")).toBeNull();
    expect(line(container)).toBe("This changes something in your account, as you.");
    expect(line(container)).not.toContain("$1.99");
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
    // "Sends 5% to Acme Utilities" was a real possible sentence here.
    expect(container.querySelector(".fl-approval-consequence-line")).toBeNull();
    expect(line(container)).toBe("This changes something in your account, as you.");
    expect(rowsOf(container)).toEqual([["Rate", "5%"], ["Recipient name", "Acme Utilities"]]);
  });

  it("H-7 — money NESTED in the args blocks the sentence and the fold", () => {
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
    expect(container.querySelector(".fl-approval-consequence-line")).toBeNull();
    expect(line(container)).toBe("This changes something in your account, as you.");
    // Both amounts stay in plain sight, formatted, with nothing folded.
    expect(container.querySelector(".fl-approval-details")).toBeNull();
    expect(rowsOf(container)).toEqual([
      ["Amount cents", "$47.50"],
      ["Recipient name", "Acme Utilities"],
      ["Extras", "Tip cents: $25.00"],
    ]);
  });

  it("H-7 — one amount, however deep, still earns its sentence", () => {
    const container = show(ask({
      call: {
        id: "call_send",
        tool: "host_transferMoney",
        args: { charge: { amount_cents: 1850 }, recipient_name: "Acme Utilities" },
      },
      descriptor: { name: "host_transferMoney", title: "Send money", description: "", inputSchema: {}, risk: "write" },
    } as Partial<ApprovalRequest>));
    expect(line(container)).toBe("Sends $18.50 to Acme Utilities — now, as you.");
  });

  it("keeps folding the fields behind Details on an ORDINARY consequence ask", () => {
    const container = show(money({ critical: false }));
    expect(line(container)).toBe("Sends $47.50 to Acme Utilities — now, as you.");
    expect(container.querySelector(".fl-approval-details")).not.toBeNull();
  });

  it("UNGRADED never folds and never loses the ceremony (ruling 15, second half)", () => {
    // The wire graded nothing. Ruling 15 made the DISPLAY grade a write; the
    // card then treated the ask as ordinary — `critical` false — so the
    // consequence sentence folded the real inputs behind Details and the
    // ceremony edge was dropped. Scrutiny must not be reduced on a grade
    // nobody supplied.
    //
    // ⚠️ TEST EDIT (#747): the ceremony is unchanged and still asserted below.
    // What changed is where it comes from. The wave approximated the state as
    // `write` + `critical: true`; `ungraded` is a first-class RiskLabel now, so
    // the wire carries it as itself and each card derives ceremony from the
    // GRADE. The old assertion pinned the approximation.
    const approval = buildApprovalRequest({
      approvalId: "apr_ungraded",
      toolCallId: "call_ungraded",
      tool: "host_transferMoney",
      args: { amount_cents: 4750, recipient_name: "Acme Utilities" },
    }, {});
    expect(approval.descriptor.risk).toBe("ungraded");
    const container = show(approval);
    expect(line(container)).toBe("Sends $47.50 to Acme Utilities — now, as you.");
    expect(container.querySelector(".fl-approval-details")).toBeNull();
    expect(container.querySelector(".fl-cardshell--ceremony")).not.toBeNull();
    expect(container.querySelector(".fl-btn-ceremony")).not.toBeNull();
  });

  it("a GRADED ask is untouched — it still folds", () => {
    const graded = buildApprovalRequest({
      approvalId: "apr_graded",
      toolCallId: "call_graded",
      tool: "host_transferMoney",
      args: { amount_cents: 4750, recipient_name: "Acme Utilities" },
      risk: "write",
    }, {});
    expect(graded.descriptor.critical).toBeUndefined();
    expect(show(graded).querySelector(".fl-approval-details")).not.toBeNull();
  });
});

describe("the venue byline never prints an id", () => {
  const inApp = (over: Partial<ApprovalRequest["ctx"]>): ApprovalRequest => ask({
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "app", presence: "present", ...over },
  } as Partial<ApprovalRequest>);

  it("says the bare phrase when the only thing known about the app is its id", () => {
    const container = show(inApp({ appId: "app_1" }));
    const byline = container.querySelector(".fl-card-byline")!.textContent!;
    expect(byline).toBe("Runs as you · asked in an app");
    expect(byline).not.toContain("app_1");
  });

  it("uses a human venue name when the surface knows one", () => {
    render(
      <VendoProvider client={client}>
        <ApprovalCard approval={inApp({ appId: "app_1" })} onDecide={() => undefined} venueName="Money HQ" />
      </VendoProvider>,
    );
    expect(screen.getByText("Runs as you · asked in Money HQ")).toBeTruthy();
  });

  it("refuses an id-shaped token from ANY source, and never reads a raw venue slug", () => {
    for (const token of ["app_1", "apr_9", "thr_x", "grt_7", "run_2"]) {
      expect(venueByline("app", token)).toBe("Runs as you · asked in an app");
      expect(venueByline("automation", token)).toBe("Runs as you · asked by an automation");
    }
    expect(venueByline("automation", "Weekly digest")).toBe("Runs as you · asked by Weekly digest");
    // An unknown venue prints the one thing still true, never the slug.
    expect(venueByline("app_1")).toBe("Runs as you");
    expect(venueByline("some-new-venue")).toBe("Runs as you");
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
    expect(rowsOf(container)).toEqual([["Amount", "$47.50"], ["Recipient name", "Acme Utilities"]]);
    expect(screen.getByLabelText("Real tool inputs").textContent).not.toContain("4750");
    expect(container.querySelector(".fl-card-title")!.textContent).toBe("Send money");
    // This line used to pin the authored descriptor sentence. The consequence
    // synthesized from the real inputs is MORE specific (it names the money and
    // the counterparty), so it now leads — see the plain-words precedence.
    expect(container.querySelector(".fl-card-line")!.textContent).toBe("Sends $47.50 to Acme Utilities — now, as you.");
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
    expect(container.querySelector(".fl-card-line")!.textContent).toBe("Send an email as you.");
  });
});
