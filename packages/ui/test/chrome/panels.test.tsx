// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ActivityPanel, AutomationsPanel } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("ActivityPanel and AutomationsPanel exports", () => {
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

  it("renders humanized activity rows and appends the next page", async () => {
    render(<VendoProvider client={client}><ActivityPanel /></VendoProvider>);
    // The raw slug host_invoices_list is humanized at the render site (ENG-216/224).
    await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(2));
    // Formatted, human timestamp rather than a raw ISO instant.
    expect(screen.getAllByText("Jul 11, 2026, 12:00 PM").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(3));
    expect(wire.requests).toContainEqual(expect.objectContaining({ method: "GET", path: "/activity?cursor=eyJjIjoiMjAyNi0wNy0xMVQxMjowMDowMC4wMDBaIiwiaSI6ImF1ZF8yIn0" }));
  });

  it("retires Load more and shows an end-of-list marker once the history is exhausted", async () => {
    render(<VendoProvider client={client}><ActivityPanel /></VendoProvider>);
    await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(2));
    // First page more: appends aud_3 — still more to come.
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(3));
    // Next page repeats seen rows: the panel resolves to the end of the list.
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByTestId("activity-end")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("toggles, captures the grant SET, previews, expands runs, and stops a running run", async () => {
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    const toggle = await screen.findByRole("switch", { name: "Enable Invoice watcher" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    // ONE set card for both minted asks (criterion 18): every permission
    // enumerated, exactly one Approve and one Deny.
    const card = await screen.findByLabelText("Standing access — Invoice watcher");
    expect(card.textContent).toContain("Invoice watcher needs 2 permissions");
    expect(card.textContent).toContain("Send email digests as you.");
    expect(card.textContent).toContain("Read invoices across your account.");
    expect(card.querySelectorAll("button")).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Allow both & enable" }));
    await waitFor(() => expect(screen.queryByLabelText("Standing access — Invoice watcher")).toBeNull());
    // ONE decision decided the WHOLE set (criterion 19 atomicity).
    expect(wire.requests).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/approvals/decide",
      body: { ids: ["apr_set_1", "apr_set_2"], decision: { approve: true } },
    }));

    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    expect((await screen.findByLabelText("Dry run for Invoice watcher")).textContent).toContain("host_invoices_list — ready");

    fireEvent.click(screen.getByRole("button", { name: "Run history" }));
    const stop = await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    await waitFor(() => expect(screen.getByText("stopped")).toBeTruthy());
    expect(wire.requests).toContainEqual(expect.objectContaining({ method: "POST", path: "/runs/run_1/stop" }));

    fireEvent.click(screen.getByRole("switch", { name: "Enable Invoice watcher" }));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
    expect(wire.requests).toContainEqual(expect.objectContaining({ method: "POST", path: "/automations/app_auto/disable" }));
  });

  it("renders outstanding grant sets from the store projection after a reload (criterion 21)", async () => {
    // Simulate the post-reload world: the asks were minted in an EARLIER
    // session — they exist server-side only; no enable() result in memory.
    // (No running run: the "running now" line otherwise owns the sub line.)
    wire.state.runs.length = 0;
    wire.state.automations[0]!.enabled = true;
    wire.state.approvals.push(
      {
        ...wire.state.approvals[0]!,
        id: "apr_set_1",
        call: { id: "call_apr_set_1", tool: "host_email_send", args: {} },
        descriptor: { name: "host_email_send", description: "Send email digests as you.", inputSchema: { type: "object" }, risk: "read" },
        ctx: { principal: { kind: "user", subject: "user_1" }, venue: "automation", presence: "present", appId: "app_auto" },
      },
      {
        ...wire.state.approvals[0]!,
        id: "apr_set_2",
        call: { id: "call_apr_set_2", tool: "host_invoices_list", args: {} },
        descriptor: { name: "host_invoices_list", description: "Read invoices across your account.", inputSchema: { type: "object" }, risk: "read" },
        ctx: { principal: { kind: "user", subject: "user_1" }, venue: "automation", presence: "present", appId: "app_auto" },
      },
    );
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);

    const card = await screen.findByLabelText("Standing access — Invoice watcher");
    expect(card.textContent).toContain("Invoice watcher needs 2 permissions");
    expect(screen.getByText("Enabled · waiting on 2 permissions")).toBeTruthy();
  });

  it("Deny on the set card grants nothing and disarms the automation in the ONE decision (criterion 19)", async () => {
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable Invoice watcher" }));
    await screen.findByLabelText("Standing access — Invoice watcher");

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.queryByLabelText("Standing access — Invoice watcher")).toBeNull());
    expect(wire.requests).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/approvals/decide",
      body: { ids: ["apr_set_1", "apr_set_2"], decision: { approve: false } },
    }));
    // Deny is transactional server-side: the decide itself disarmed the row —
    // no second disable request exists to fail after the asks are gone.
    expect(wire.requests.filter(request => request.path === "/automations/app_auto/disable")).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Invoice watcher" }).getAttribute("aria-checked")).toBe("false"));
    // Nothing granted: no grant rows were minted by the deny.
    expect(wire.state.approvals.filter(item => item.ctx.appId === "app_auto")).toHaveLength(0);
  });

  it("a failed deny surfaces IN the card and stays retryable — never a vanished card with a live automation", async () => {
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable Invoice watcher" }));
    await screen.findByLabelText("Standing access — Invoice watcher");
    wire.state.failures.push({
      method: "POST",
      path: "/approvals/decide",
      code: "sandbox-unavailable",
      message: "Store briefly unavailable",
      status: 503,
    });

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    // Visible failure: the card keeps its actions (retry is one click) and
    // NOTHING was decided — asks still pending, automation state untouched.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Store briefly unavailable");
    const card = screen.getByLabelText("Standing access — Invoice watcher");
    expect(card.contains(alert)).toBe(true);
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(false);
    expect(wire.state.approvals.filter(item => item.ctx.appId === "app_auto")).toHaveLength(2);

    // Retry succeeds: one decision denies the set and disarms the row.
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.queryByLabelText("Standing access — Invoice watcher")).toBeNull());
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Invoice watcher" }).getAttribute("aria-checked")).toBe("false"));
  });

  it("H2: decisions succeed but the DISABLE step fails — visible retryable error, never a silent enabled+denied automation", async () => {
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable Invoice watcher" }));
    await screen.findByLabelText("Standing access — Invoice watcher");
    // The engine's in-decision disarm fails silently server-side, AND the
    // panel's explicit repair disable fails too — the worst case.
    wire.state.denyDisarmFails = true;
    wire.state.failures.push({
      method: "POST",
      path: "/automations/app_auto/disable",
      code: "sandbox-unavailable",
      message: "Store briefly unavailable",
      status: 503,
    });

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    // The DECISIONS landed (both asks decided, card gone)...
    await waitFor(() => expect(screen.queryByLabelText("Standing access — Invoice watcher")).toBeNull());
    expect(wire.state.approvals.filter(item => item.ctx.appId === "app_auto")).toHaveLength(0);
    // ...the panel attempted the repair disable...
    await waitFor(() => expect(wire.requests).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/automations/app_auto/disable",
    })));
    // ...and its failure is VISIBLE: the alert names the still-enabled
    // automation and points at the retry; the row honestly reads enabled.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("It is still enabled");
    expect(alert.textContent).toContain("Store briefly unavailable");
    expect(screen.getByRole("switch", { name: "Enable Invoice watcher" }).getAttribute("aria-checked")).toBe("true");

    // Retry IS the toggle: the next disable succeeds and the row disarms.
    fireEvent.click(screen.getByRole("switch", { name: "Enable Invoice watcher" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Invoice watcher" }).getAttribute("aria-checked")).toBe("false"));
  });

  it("H2 guardrail: the repair never disarms a PARTIALLY granted automation (05 §6 law)", async () => {
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable Invoice watcher" }));
    await screen.findByLabelText("Standing access — Invoice watcher");
    // The consent moment granted the automation something: a live
    // automation-source standing grant exists for this app.
    wire.state.denyDisarmFails = true; // row stays enabled — correctly, per the law
    wire.state.grants.push({
      id: "grt_partial",
      subject: "user_1",
      tool: "host_email_send",
      descriptorHash: "sha256:fixture",
      scope: { kind: "tool" },
      duration: "standing",
      source: "automation",
      appId: "app_auto",
      grantedAt: "2026-07-11T12:00:00.000Z",
    });

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.queryByLabelText("Standing access — Invoice watcher")).toBeNull());
    // No repair disable fired, no error raised — the armed row is the law.
    expect(wire.requests.filter(request => request.path === "/automations/app_auto/disable")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("switch", { name: "Enable Invoice watcher" }).getAttribute("aria-checked")).toBe("true");
  });

  it("backward-compat: a legacy payload WITHOUT pendingGrants/grantSetId still parses, renders, and decides", async () => {
    // An older server: /automations entries and the enable result carry none
    // of the grant-set fields. The panel must render unchanged — the set card
    // still derives from the pending approvals, the count falls back to the
    // asks themselves, and the decision goes out without a set id.
    wire.state.legacyAutomationsPayload = true;
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    const toggle = await screen.findByRole("switch", { name: "Enable Invoice watcher" });
    fireEvent.click(toggle);

    const card = await screen.findByLabelText("Standing access — Invoice watcher");
    expect(card.textContent).toContain("Invoice watcher needs 2 permissions");
    fireEvent.click(screen.getByRole("button", { name: "Allow both & enable" }));

    await waitFor(() => expect(screen.queryByLabelText("Standing access — Invoice watcher")).toBeNull());
    const decide = wire.requests.find(request => request.method === "POST" && request.path === "/approvals/decide");
    expect(decide?.body).toEqual({ ids: ["apr_set_1", "apr_set_2"], decision: { approve: true } });
  });

  it("backward-compat: an entry with no pending grants renders the plain Enabled row (no waiting copy)", async () => {
    wire.state.runs.length = 0;
    wire.state.automations[0]!.enabled = true;
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    await screen.findByRole("switch", { name: "Enable Invoice watcher" });
    expect(await screen.findByText("Enabled")).toBeTruthy();
    expect(screen.queryByText(/waiting on/)).toBeNull();
    expect(screen.queryByLabelText(/^Standing access/)).toBeNull();
  });

  it("renders a scheduler-refused run as failed with its blocked reason in run history (pricing v3 §5)", async () => {
    const blockedReason =
      "blocked by allowance: Vendo Cloud paused automation runs — the allowance for this billing "
      + "period is used up (resets 2026-08-01). Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo).";
    wire.state.runs.push({
      id: "run_blocked",
      appId: "app_auto",
      trigger: { kind: "schedule" },
      status: "error",
      startedAt: "2026-07-11T12:00:00.000Z",
      finishedAt: "2026-07-11T12:00:05.000Z",
      steps: [],
      error: { code: "meter-exhausted", message: blockedReason },
    });
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    await screen.findByRole("switch", { name: "Enable Invoice watcher" });

    fireEvent.click(screen.getByRole("button", { name: "Run history" }));
    // The refused run reads as a plain failed run: error status row + the
    // refusal's own code and reason on the run's alert line.
    const reason = await screen.findByText(`meter-exhausted: ${blockedReason}`);
    expect(reason.getAttribute("role")).toBe("alert");
    expect(reason.closest("article")?.textContent).toContain("error");
  });

  it("contains activity wire errors in an alert without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    render(<VendoProvider client={client}><ActivityPanel /></VendoProvider>);
    await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(2));
    wire.state.failures.push({
      method: "GET",
      path: "/activity",
      code: "not-implemented",
      message: "Activity unavailable",
      status: 501,
    });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Activity unavailable");
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("contains automation wire errors in an alert without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    const toggle = await screen.findByRole("switch", { name: "Enable Invoice watcher" });
    wire.state.failures.push({
      method: "POST",
      path: "/automations/app_auto/enable",
      code: "sandbox-unavailable",
      message: "Automation unavailable",
      status: 501,
    });

    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toContain("Automation unavailable");
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
