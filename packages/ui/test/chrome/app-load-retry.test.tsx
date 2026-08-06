// @vitest-environment jsdom
// Keystone graduates A5 — a transient `apps.open` failure used to skeleton a
// pinned app forever: useApp recorded the error, every surface kept rendering
// "Loading app…", and only a full page reload got the user out. The load now
// retries with backoff, and a load that really is dead offers a way back in.
import type { AppDocument } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

const pinned: AppDocument = {
  format: "vendo/app@1",
  id: "app_1",
  name: "Invoices",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Invoices app surface" } }],
  },
};

describe("useApp load retry (Keystone graduates A5)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
    // Discovery is placement ROWS now (2026-08-05): the slot reads
    // GET /apps/placements, not the app list. The document below still drives
    // apps.open — which is what this file is actually about.
    vi.spyOn(client.apps, "placements").mockResolvedValue([
      { slot: "hero", app: "app_1", title: "Invoices", status: "ready" },
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  it("rides out a transient open failure instead of skeletoning forever", async () => {
    const open = client.apps.open.bind(client.apps);
    const spy = vi.spyOn(client.apps, "open")
      .mockRejectedValueOnce(new Error("network hiccup"))
      .mockImplementation(open);

    render(<VendoProvider client={client}><VendoSlot id="hero" /></VendoProvider>);

    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("gives up after a bounded number of attempts and offers a retry", async () => {
    const open = client.apps.open.bind(client.apps);
    const spy = vi.spyOn(client.apps, "open").mockRejectedValue(new Error("app machine is down"));

    render(<VendoProvider client={client}><VendoSlot id="hero" /></VendoProvider>);

    const retry = await screen.findByRole("button", { name: /try again/i });
    expect(spy.mock.calls).toHaveLength(3);
    // The consumer-voice law (spec §16 law 3, wave-3 integration): a slot sits on
    // the HOST'S OWN PAGE, so the developer's sentence ("app machine is down" —
    // and in the wild an env-var name or an app id) must never be what the person
    // reads. This assertion used to demand exactly that raw string.
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toContain("Something on our side didn’t answer");
    expect(alert).not.toContain("app machine is down");

    // The affordance is real: with the wire healed, the same button loads the app.
    spy.mockImplementation(open);
    fireEvent.click(retry);
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
  });

  it("keeps showing the skeleton while the retries are still in flight", async () => {
    vi.spyOn(client.apps, "open").mockRejectedValue(new Error("app machine is down"));

    render(<VendoProvider client={client}><VendoSlot id="hero" /></VendoProvider>);

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Loading app…"));
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});
