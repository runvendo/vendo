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

  it("renders activity fixture rows and appends the next page", async () => {
    render(<VendoProvider client={client}><ActivityPanel /></VendoProvider>);
    await waitFor(() => expect(screen.getAllByText("host_invoices_list")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByText("host_invoices_list")).toHaveLength(3));
    expect(wire.requests).toContainEqual(expect.objectContaining({ method: "GET", path: "/activity?cursor=eyJjIjoiMjAyNi0wNy0xMVQxMjowMDowMC4wMDBaIiwiaSI6ImF1ZF8yIn0" }));
  });

  it("toggles, captures missing approvals, previews, expands runs, and stops a running run", async () => {
    render(<VendoProvider client={client}><AutomationsPanel /></VendoProvider>);
    const toggle = await screen.findByRole("switch", { name: "Enable Invoice watcher" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(await screen.findByLabelText("Approval for host_email_send")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByLabelText("Approval for host_email_send")).toBeNull());

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

  it("contains activity wire errors in an alert without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    render(<VendoProvider client={client}><ActivityPanel /></VendoProvider>);
    await waitFor(() => expect(screen.getAllByText("host_invoices_list")).toHaveLength(2));
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
