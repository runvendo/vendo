// @vitest-environment jsdom
// 2026-07 demo feedback — the in-thread automation card: the chrome renders a
// `data-vendo-automation` stream part with the same card vocabulary as the
// workspace Automations panel (read-only — management stays in the panel).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { AutomationCard } from "../../src/chrome/index.js";
import { humanizeCron } from "../../src/chrome/automation-card.js";
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

describe("AutomationCard", () => {
  it("renders identity, enabled state, and the trigger → action flow", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard
          name="Low balance alert"
          enabled
          description="Emails you when checking dips below $2,000."
          trigger={{
            on: { kind: "schedule", cron: "0 8 * * *" },
            run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
          }}
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Automation — Low balance alert" });
    expect(card.textContent).toContain("Low balance alert");
    expect(card.textContent).toContain("Enabled");
    expect(card.textContent).toContain("Emails you when checking dips below $2,000.");
    // The flow nodes: humanized cron trigger → humanized first step.
    expect(card.textContent).toContain("Daily at 8:00 AM");
    expect(card.textContent).toContain("List accounts");
    // Read-only: no toggle, no run history.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run history" })).toBeNull();
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
    expect(card.textContent).toContain("Fridays at 5:00 PM");
    expect(card.textContent).toContain("2 steps");
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
