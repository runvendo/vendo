// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider, type VendoClient } from "../../src/index.js";
import { AutomationsPanel } from "../../src/chrome/index.js";
import type { AutomationEntry } from "../../src/wire-types.js";

/**
 * Build contract §9.9 — a sponsorship that lapses STOPS the automation, and the
 * list is the one place someone can find it again (E8-F2: it simply vanished
 * from view, reading as an ordinary "Disabled" nobody had any reason to look
 * at). The server sends the consumer sentence; this panel has to show it.
 */

afterEach(cleanup);

const entry = (over: Partial<AutomationEntry> = {}): AutomationEntry => ({
  app: {
    format: VENDO_APP_FORMAT,
    id: "app_digest",
    name: "Invoice digest",
    trigger: {
      on: { kind: "schedule", cron: "0 9 * * *" },
      run: { kind: "steps", steps: [{ id: "read", tool: "host_invoices_list" }] },
    },
  },
  enabled: false,
  ...over,
});

function mount(entries: AutomationEntry[]): void {
  const client = {
    async status() { return { posture: "unconfigured" }; },
    automations: {
      async list() { return entries; },
      async enable() { return { enabled: true, missing: [] }; },
      async disable() { return undefined; },
      async dryRun() { return { steps: [], grantsMissing: [] }; },
    },
    runs: { async list() { return { runs: [] }; }, async stop() { return undefined; } },
    grants: { async list() { return []; } },
    approvals: { async pending() { return []; }, async decide() { return { decided: [] }; } },
  } as unknown as VendoClient;
  render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
}

describe("a STOPPED automation is findable in the list", () => {
  it("shows the server's consumer sentence instead of a bare Disabled", async () => {
    mount([entry({
      stopped: {
        reason: "departure",
        summary: "This stopped because the person it ran as no longer has access to the app.",
      },
    })]);

    const notice = await screen.findByText(/no longer has access to the app/i);
    expect(notice).toBeTruthy();
    // It must read as PAUSED-AND-WAITING, not as something somebody switched off.
    // Exact match: the summary sentence contains the word too.
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.queryByText("Disabled")).toBeNull();
  });

  it("says nothing extra about an automation that is merely off", async () => {
    mount([entry()]);
    await screen.findByText("Invoice digest");
    expect(screen.queryByText(/stopped/i)).toBeNull();
  });

  it("never names the sponsor in the stopped notice — anyone who can edit reads it", async () => {
    mount([entry({
      sponsor: { subject: "maple-mia" },
      stopped: { reason: "edit", summary: "This stopped because the app changed after it was set up." },
    })]);

    const notice = await screen.findByText(/the app changed after it was set up/i);
    expect(notice.textContent).not.toContain("maple-mia");
  });
});
