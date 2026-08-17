// @vitest-environment jsdom
// 2026-07 demo feedback — the in-thread automation card: the chrome renders a
// `data-vendo-automation` stream part with the same card vocabulary as the
// card vocabulary the workspace panel used to share. Since #1090 the card is
// ALSO the arming consent surface: its pending asks ride the durable
// approvals feed and are decidable in place — the overlay's conversation does
// not survive a page navigation, so a separate page cannot carry the arming
// decision.
import { vendoAutomationPartSchema, type ApprovalRequest } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { AutomationCard } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { humanizeCron, triggerLabel } from "../../src/chrome/automation-card.js";
import { allowLabel } from "../../src/chrome/grant-set-card.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { createWireServer } from "../wire-server.js";

afterEach(cleanup);

const client = createVendoClient({ baseUrl: "http://127.0.0.1:9" });

describe("humanizeCron", () => {
  it("humanizes the simple fixed-time forms", () => {
    expect(humanizeCron("0 17 * * 5")).toBe("Fridays at 5:00 PM");
    expect(humanizeCron("0 8 * * *")).toBe("Daily at 8:00 AM");
    expect(humanizeCron("30 12 * * 0")).toBe("Sundays at 12:30 PM");
  });

  it("leaves anything fancier to the raw cron", () => {
    expect(humanizeCron("*/5 * * * *")).toBeNull();
    expect(humanizeCron("0 17 * * 1-5")).toBeNull();
    expect(humanizeCron("0 99 * * *")).toBeNull();
  });
});

describe("triggerLabel — which zone the clock is in", () => {
  const scheduled = (cron: string) => triggerLabel({ kind: "schedule", cron });

  it("names the zone on a humanized cron clock, because UTC is the zone it fires in", () => {
    // The engine builds every cron with `{ timezone: "UTC" }` (engine.ts §325,
    // §2068), so "0 16 * * 1" fires at 4 PM UTC — 8 AM Pacific. An unlabelled
    // "Mondays at 4:00 PM" was read as the reader's OWN afternoon: someone who
    // asked for 8 AM Pacific was shown a time eight hours off with nothing on
    // screen to say so.
    // ⚠️ TEST EDIT (A1 · Sentence): `triggerLabel` returns the label itself now
    // — the second `sub` field ("Schedule", "Host event") labelled the retired
    // diagram's boxes and had no other reader. Same labels, same zone rule.
    expect(scheduled("0 16 * * 1")).toBe("Mondays at 4:00 PM UTC");
    expect(scheduled("0 8 * * *")).toBe("Daily at 8:00 AM UTC");
  });

  it("leaves a raw cron expression alone — it shows no clock time to mislabel", () => {
    // "*/5 * * * *" is a cadence, not an hour. There is no hour on screen for a
    // reader to misplace, so a zone label here would be noise.
    expect(scheduled("*/5 * * * *")).toBe("*/5 * * * *");
  });

  it("names the connector when a webhook record names no event", () => {
    // An external record's event is optional: nothing has fired yet, and the
    // connector is what the person actually armed.
    expect(triggerLabel({ kind: "external", connector: "stripe" })).toBe("Stripe");
    expect(triggerLabel({ kind: "external", connector: "gmail", event: "new_bill_email" }))
      .toBe("New bill email");
  });
});

describe("AutomationCard", () => {
  /** ⚠️ TEST EDIT (A1 · Sentence): this asserted the head's identity (the NAME
      as the title) and the flow diagram's two node boxes with their sub labels
      ("Schedule", "1 action"). The rule is the card's title now, so the same
      facts are asserted where they render: the description IS the title, the
      name is the card's accessible name, and the composed `trigger → action`
      title is covered by the no-description case below (the diagram's sub
      labels are gone with the diagram — they named the boxes, not the rule). */
  it("renders the rule as its title, the enabled state, and the agency line", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard
          name="Low balance alert"
          enabled
          description="Emails you when checking dips below $2,000."
          sponsor={{ subject: "user_1", display: "Dana" }}
          when={{ kind: "schedule", cron: "0 8 * * *" }}
          action="List accounts"
        />
      </VendoProvider>,
    );
    // The name is what the card is CALLED, and it stays its accessible name.
    const card = screen.getByRole("article", { name: "Automation — Low balance alert" });
    // The rule, in the description's human phrasing, as the card's first line.
    expect(card.querySelector(".fl-auto-sentence")!.textContent)
      .toBe("Emails you when checking dips below $2,000.");
    // §13 — whether it is on AND whose access it runs with, on one quiet line
    // (this was the state chip plus the byline row).
    expect(card.querySelector(".fl-auto-state")!.textContent)
      .toBe("Enabled · Runs with Dana's access");
    // Read-only: no toggle, no run history.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run history" })).toBeNull();
    // No head, and no diagram saying in two boxes what the title says in words.
    expect(card.querySelector(".fl-card-eyebrow")).toBeNull();
    expect(card.querySelector(".fl-card-ic")).toBeNull();
    expect(card.querySelector(".fl-auto-flow")).toBeNull();
  });

  /** An EMPTY description is not a phrasing. It used to empty a quiet line;
      as the card's 14px title it empties the card's whole first line — the
      `??` that only guards `undefined` walked straight into it. */
  it("falls back to the composed rule when the description is blank", () => {
    for (const description of ["", "   "]) {
      render(
        <VendoProvider client={client}>
          <AutomationCard
            name="Low balance alert"
            enabled
            description={description}
            when={{ kind: "schedule", cron: "0 8 * * *" }}
            action="List accounts"
          />
        </VendoProvider>,
      );
      const card = screen.getByRole("article", { name: "Automation — Low balance alert" });
      expect(card.querySelector(".fl-auto-sentence")!.textContent, JSON.stringify(description))
        .toBe("Daily at 8:00 AM UTC → List accounts");
      cleanup();
    }
  });

  /** The card CLIPS (`.fl-automation` sets overflow: hidden), and a flex item
      will not shrink below its content — so the two flex lines this redesign
      introduced have to be told they may wrap, or a long unbroken token is cut
      off at the card's edge. The sponsor half is the live case: `subject` is an
      opaque id when no display name is known, and the byline row it replaced
      wrapped by default. jsdom computes no layout, so the contract is asserted
      on the shipped sheet (the mobile block's precedent) plus the DOM hooks. */
  it("lets a long unbroken token wrap instead of clipping", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard
          name="Low balance alert"
          enabled
          description="Watches checking"
          sponsor={{ subject: "auth0|6d5f4e3c2b1a0998877665544332211fedcba9876543210" }}
          rules={[`pays ${"n".repeat(40)}`]}
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Automation — Low balance alert" });
    // The id-shaped subject is displayed, not swallowed — and it is the text
    // half of the flex row, so it is the half that may wrap.
    expect(card.querySelector(".fl-auto-state-copy")!.textContent)
      .toBe("Enabled · Runs with auth0|6d5f4e3c2b1a0998877665544332211fedcba9876543210's access");
    expect(CHROME_CSS).toMatch(/\.fl-auto-state-copy \{[^}]*min-width: 0; overflow-wrap: anywhere/);
    expect(CHROME_CSS).toMatch(/\.fl-auto-rules li \{[^}]*min-width: 0;\n\s*overflow-wrap: anywhere/);
    // And the dot never shrinks to nothing to make room for that text.
    expect(CHROME_CSS).toMatch(/\.fl-auto-state \.fl-auto-live \{[^}]*flex-shrink: 0/);
  });

  it("composes the rule from when → action when the record has no description", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard
          name="Low balance alert"
          enabled={false}
          when={{ kind: "schedule", cron: "0 8 * * *" }}
          action="List accounts"
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Automation — Low balance alert" });
    // The humanized cron (zone named, because it fires in UTC) → the action.
    expect(card.querySelector(".fl-auto-sentence")!.textContent).toBe("Daily at 8:00 AM UTC → List accounts");
    // Disabled says so, and drops the live dot rather than colouring it.
    expect(card.querySelector(".fl-auto-state")!.textContent).toBe("Disabled");
    expect(card.querySelector(".fl-auto-live")).toBeNull();
  });

  /** E3 · Rule list — the agent's own sentences about how the automation
      behaves. A real <ul> with an accessible name: these are N distinct
      promises, and a reader has to be able to step through them. */
  it("lists the agent's rule sentences, and renders no list at all without them", () => {
    const rules = [
      "Caps at $200 a bill — anything higher asks you first",
      "Only bills from billing@pge.com count",
    ];
    const { rerender } = render(
      <VendoProvider client={client}>
        <AutomationCard name="PG&E autopay" enabled rules={rules} description="New PG&E bill → paid from Maple Checking" />
      </VendoProvider>,
    );
    const list = screen.getByRole("list", { name: "Rules for PG&E autopay" });
    expect([...list.querySelectorAll("li")].map(item => item.textContent)).toEqual(rules);
    // The tick is decoration beside each sentence, never the sentence itself.
    expect(list.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(2);

    rerender(
      <VendoProvider client={client}>
        <AutomationCard name="PG&E autopay" enabled description="New PG&E bill → paid from Maple Checking" />
      </VendoProvider>,
    );
    expect(screen.queryByRole("list", { name: "Rules for PG&E autopay" })).toBeNull();
  });
});

describe("ThreadPart data-vendo-automation", () => {
  const part = (data: Record<string, unknown>) => ({
    type: "data-vendo-automation",
    data,
  }) as never;

  it("renders the automation card from the wire part", () => {
    render(
      <VendoProvider client={client}>
        <ThreadPart
          part={part({
            automationId: "atm_demo",
            name: "Weekly spending summary",
            enabled: true,
            when: { kind: "schedule", cron: "0 17 * * 5" },
            action: "Get spending insights",
          })}
          partKey="m-0"
          role="assistant"
          restored={false}
          risks={new Map()}
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Automation — Weekly spending summary" });
    // ⚠️ TEST EDIT (A1 · Sentence): the trigger and the action used to be two
    // node boxes with sub labels ("Schedule", "2 steps"). They are one rule
    // sentence now, so the wire→card contract is asserted on that sentence —
    // the humanized cron and the producer's action half both come off the part.
    expect(card.querySelector(".fl-auto-sentence")!.textContent)
      .toBe("Fridays at 5:00 PM UTC → Get spending insights");
    // Backward-compat: this is the OLD wire payload (no pendingGrants) — it
    // renders the plain enabled state, never the waiting copy.
    expect(card.textContent).toContain("Enabled");
    expect(card.textContent).not.toContain("waiting on");
  });

  /** The wire carries the automation's terms on the PART itself. Pinned through
      the REAL part schema, because the bridge validates before this renders: a
      part that fails there never reaches the card at all. */
  it("carries the record's rule sentences onto the card, through the real part schema", () => {
    const wire = {
      type: "data-vendo-automation",
      automationId: "atm_demo",
      name: "PG&E autopay",
      enabled: true,
      description: "New PG&E bill → paid from Maple Checking",
      when: { kind: "external", connector: "gmail", event: "new_bill_email" },
      action: "Pay the bill",
      rules: [
        "Caps at $200 a bill — anything higher asks you first",
        // A blank sentence from a sloppy author must cost ITSELF and nothing
        // else: the schema lets it through (so the card still arrives) and the
        // renderer drops it. Before, `min(1)` here failed the whole part.
        "   ",
        "Skips if checking would drop below $500",
      ],
    };
    const parsed = vendoAutomationPartSchema.safeParse(wire);
    expect(parsed.success, "a blank rule must never fail the automation part").toBe(true);
    render(
      <VendoProvider client={client}>
        <ThreadPart part={part(parsed.data!)} partKey="m-2" role="assistant" restored={false} risks={new Map()} />
      </VendoProvider>,
    );
    const list = screen.getByRole("list", { name: "Rules for PG&E autopay" });
    expect([...list.querySelectorAll("li")].map(item => item.textContent)).toEqual([
      "Caps at $200 a bill — anything higher asks you first",
      "Skips if checking would drop below $500",
    ]);
  });

  /** A card is the moment's record, not the settings page: whatever a record
      says, the render is bounded — six sentences, each at the clamp the rule
      sentence's own action half has always used. */
  it("bounds what a record can push onto the card", () => {
    render(
      <VendoProvider client={client}>
        <ThreadPart
          part={part({
            automationId: "atm_demo",
            name: "Noisy",
            enabled: true,
            description: "Runs",
            rules: [`${"x".repeat(400)} tail`, ...Array.from({ length: 20 }, (_, index) => `Rule ${index}`)],
          })}
          partKey="m-3"
          role="assistant"
          restored={false}
          risks={new Map()}
        />
      </VendoProvider>,
    );
    const items = [...screen.getByRole("list", { name: "Rules for Noisy" }).querySelectorAll("li")];
    expect(items).toHaveLength(6);
    expect(items[0]!.textContent).toBe(`${"x".repeat(67)}…`);
    expect(items[0]!.textContent!.length).toBeLessThanOrEqual(68);
  });

  it("reads 'waiting on N permissions' while the part carries pendingGrants (grant sets)", () => {
    render(
      <VendoProvider client={client}>
        <ThreadPart
          part={part({
            automationId: "atm_demo",
            name: "Weekly spending summary",
            enabled: true,
            pendingGrants: 2,
          })}
          partKey="m-1"
          role="assistant"
          restored={false}
          risks={new Map()}
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Automation — Weekly spending summary" });
    expect(card.textContent).toContain("Enabled · waiting on 2 permissions");
  });

  it("ignores a malformed part (no automationId/name)", () => {
    const { container } = render(
      <VendoProvider client={client}>
        <ThreadPart
          part={part({ enabled: true })}
          partKey="m-0"
          role="assistant"
          restored={false}
          risks={new Map()}
        />
      </VendoProvider>,
    );
    expect(container.querySelector("[data-vendo-automation-card]")).toBeNull();
  });
});

describe("ThreadPart data-vendo-automation — the arming consent surface (#1090)", () => {
  const part = (data: Record<string, unknown>) => ({
    type: "data-vendo-automation",
    data,
  }) as never;

  /** The two standing asks the arming capture parks for atm_auto — the shape
   *  the wire's own grant-set fixtures mint (and, since #1093, the shape the
   *  ref-filtered approvals feed can actually return). The RECORD it is for
   *  rides `ctx.trigger`: an automation has no app for the card to match on. */
  const armingAsk = (id: string, tool: string, risk: "read" | "write"): ApprovalRequest => ({
    id,
    call: { id: `call_${id}`, tool, args: {} },
    descriptor: { name: tool, description: "Model-facing line.", inputSchema: { type: "object" }, risk },
    inputPreview: `Allow "Invoice watcher" to use ${tool} while you're away (standing, this automation only)`,
    ctx: {
      principal: { kind: "user", subject: "user_1" },
      venue: "automation",
      presence: "present",
      trigger: { runId: "run_arm", kind: "schedule", automationId: "atm_auto" },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const renderCard = (wireClient: ReturnType<typeof createVendoClient>, automationId: string) => render(
    <VendoProvider client={wireClient}>
      <ThreadPart
        part={part({ automationId, name: "Invoice watcher", enabled: true, pendingGrants: 2 })}
        partKey="m-consent"
        role="assistant"
        restored={false}
        risks={new Map()}
      />
    </VendoProvider>,
  );

  it("renders the pending set from the durable feed and one Allow settles it", async () => {
    const wire = await createWireServer();
    try {
      wire.state.approvals = [
        armingAsk("apr_set_1", "host_email_send", "write"),
        armingAsk("apr_set_2", "host_invoices_list", "read"),
      ];
      const wireClient = createVendoClient({ baseUrl: wire.url });
      renderCard(wireClient, "atm_auto");

      // The consent card arrives from the FEED (never the stream), with every
      // permission row and the one Allow for the whole set.
      const allow = await screen.findByRole("button", { name: allowLabel(2) });
      const set = screen.getByRole("article", { name: "Standing access — Invoice watcher" });
      expect(set.textContent).toContain("Invoice watcher needs 2 permissions");
      expect(set.textContent).toContain("Changes: Email send");
      expect(set.textContent).toContain("Reads: Invoices list");

      fireEvent.click(allow);

      // The decision reaches the wire (the asks leave the pending queue) and
      // the automation card stops claiming a debt.
      await waitFor(() => expect(wire.state.approvals).toHaveLength(0));
      await waitFor(() => {
        const card = screen.getByRole("article", { name: "Automation — Invoice watcher" });
        expect(card.textContent).not.toContain("waiting on");
      });
      // The settled record stays in the transcript.
      expect(screen.getByRole("article", { name: "Standing access — Invoice watcher" }).textContent)
        .toContain("2 permissions");
    } finally {
      await wire.close();
    }
  });

  it("keeps the part's snapshot count when the feed cannot answer — an error never reads as nothing pending", () => {
    const dead = createVendoClient({ baseUrl: "http://127.0.0.1:9" });
    renderCard(dead, "atm_dead");
    const card = screen.getByRole("article", { name: "Automation — Invoice watcher" });
    expect(card.textContent).toContain("waiting on 2 permissions");
  });
});
