// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ActivityPanel } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("ActivityPanel export", () => {
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

  it("humanizes a row's inputs and never prints the guard's raw preview (C2)", async () => {
    render(<VendoProvider client={client}><ActivityPanel /></VendoProvider>);
    await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(2));
    const row = document.querySelector(".fl-act-led-row")!;
    // The guard mints `<tool slug> <canonical JSON>`; this row used to print it.
    expect(row.textContent).not.toContain("host_invoices_list {");
    expect(row.textContent).not.toContain('"limit"');
    // The consent surfaces' own humanization, money seam included.
    expect(row.querySelector(".fl-act-led-det")?.textContent)
      .toBe(" — Amount cents $47.50 · Limit 10 · Status open");
  });

  it("keeps the raw preview for developers — dev mode only", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      render(<VendoProvider client={client}><ActivityPanel /></VendoProvider>);
      await waitFor(() => expect(screen.getAllByText("Invoices list")).toHaveLength(2));
      expect(document.querySelector(".fl-act-led-det")?.textContent)
        .toContain('host_invoices_list {"amount_cents":4750');
    } finally {
      process.env.NODE_ENV = previous;
    }
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
    // Contained and SHOWN, in the consumer's voice: "Activity unavailable" is
    // our store's own words (spec §16 law 3, the widened audit).
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("We couldn’t load more just now — try again.");
    expect(alert.textContent).not.toContain("Activity unavailable");
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
