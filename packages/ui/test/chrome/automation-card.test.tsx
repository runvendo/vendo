// @vitest-environment jsdom
// 2026-07 demo feedback — the in-thread automation card: the chrome renders a
// `data-vendo-automation` stream part with the same card vocabulary as the
// workspace Automations panel (read-only — management stays in the panel).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { AutomationCard } from "../../src/chrome/index.js";
import { humanizeCron, triggerLabel } from "../../src/chrome/automation-card.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";

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
  const scheduled = (cron: string) => triggerLabel({
    id: "main",
    on: { kind: "schedule", cron },
    run: { kind: "steps", steps: [{ id: "s", tool: "host_listAccounts" }] },
  });

  it("names the zone on a humanized cron clock, because UTC is the zone it fires in", () => {
    // The engine builds every cron with `{ timezone: "UTC" }` (engine.ts §325,
    // §2068), so "0 16 * * 1" fires at 4 PM UTC — 8 AM Pacific. An unlabelled
    // "Mondays at 4:00 PM" was read as the reader's OWN afternoon: someone who
    // asked for 8 AM Pacific was shown a time eight hours off with nothing on
    // screen to say so.
    expect(scheduled("0 16 * * 1").title).toBe("Mondays at 4:00 PM UTC");
    expect(scheduled("0 8 * * *").title).toBe("Daily at 8:00 AM UTC");
  });

  it("leaves a raw cron expression alone — it shows no clock time to mislabel", () => {
    // "*/5 * * * *" is a cadence, not an hour. There is no hour on screen for a
    // reader to misplace, so a zone label here would be noise.
    expect(scheduled("*/5 * * * *").title).toBe("*/5 * * * *");
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
          trigger={{
            on: { kind: "schedule", cron: "0 8 * * *" },
            run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
          }}
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
    expect(card.querySelector(".fl-auto-flow")).toBeNull();
  });

  it("composes the rule from the trigger when the document has no description", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard
          name="Low balance alert"
          enabled={false}
          trigger={{
            on: { kind: "schedule", cron: "0 8 * * *" },
            run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
          }}
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Automation — Low balance alert" });
    // The humanized cron (zone named, because it fires in UTC) → the first step.
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
            appId: "app_demo",
            name: "Weekly spending summary",
            enabled: true,
            trigger: {
              on: { kind: "schedule", cron: "0 17 * * 5" },
              run: { kind: "steps", steps: [{ id: "s", tool: "host_getSpendingInsights" }, { id: "t", tool: "host_listTransactions" }] },
            },
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
    // the humanized cron and the first step still both come off the part.
    expect(card.querySelector(".fl-auto-sentence")!.textContent)
      .toBe("Fridays at 5:00 PM UTC → Get spending insights");
    // Backward-compat: this is the OLD wire payload (no pendingGrants) — it
    // renders the plain enabled state, never the waiting copy.
    expect(card.textContent).toContain("Enabled");
    expect(card.textContent).not.toContain("waiting on");
  });

  it("carries the part's rule sentences onto the card (the E3 list is wire-fed)", () => {
    render(
      <VendoProvider client={client}>
        <ThreadPart
          part={part({
            appId: "app_demo",
            name: "PG&E autopay",
            enabled: true,
            description: "New PG&E bill → paid from Maple Checking",
            rules: ["Caps at $200 a bill — anything higher asks you first", "Skips if checking would drop below $500"],
          })}
          partKey="m-2"
          role="assistant"
          restored={false}
          risks={new Map()}
        />
      </VendoProvider>,
    );
    const list = screen.getByRole("list", { name: "Rules for PG&E autopay" });
    expect([...list.querySelectorAll("li")].map(item => item.textContent)).toEqual([
      "Caps at $200 a bill — anything higher asks you first",
      "Skips if checking would drop below $500",
    ]);
  });

  it("reads 'waiting on N permissions' while the part carries pendingGrants (grant sets)", () => {
    render(
      <VendoProvider client={client}>
        <ThreadPart
          part={part({
            appId: "app_demo",
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

  it("ignores a malformed part (no appId/name)", () => {
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
