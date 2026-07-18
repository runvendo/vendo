// @vitest-environment jsdom
// Shelf Task 3 — Slot pin self-discovery: the slot resolves "the app pinned to
// slot X" on its own (the polling dance demo-accounting's hero-slot used to
// hand-roll), via the useSlotApp hook over the standard useResource lifecycle.
import type { AppDocument } from "@vendoai/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, useSlotApp, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** The wire server's app_1 ("Invoices"), pinned to the hero slot. Keeping the
 *  id real lets the slot's mount path open it over the same wire. */
function pinnedApp(overrides: Partial<AppDocument> = {}): AppDocument {
  return {
    format: "vendo/app@1",
    id: "app_1",
    name: "Invoices",
    ui: "tree",
    tree: {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text: "Invoices app surface" } }],
    },
    pins: [{ slot: "hero", base: "sha256:abc123" }],
    ...overrides,
  };
}

describe("Slot pin self-discovery (useSlotApp + VendoSlot)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  function Probe({ slot, pollMs }: { slot: string; pollMs?: number }) {
    const { appId, isLoading } = useSlotApp(slot, pollMs === undefined ? {} : { pollMs });
    return <output>{isLoading ? "loading" : appId ?? "none"}</output>;
  }

  it("resolves the latest app pinned to the slot", async () => {
    vi.spyOn(client.apps, "list").mockResolvedValue([
      pinnedApp(),
      pinnedApp({ id: "app_2", name: "Newer remix" }),
      pinnedApp({ id: "app_other", pins: [{ slot: "sidebar", base: "sha256:def456" }] }),
    ]);
    render(<VendoProvider client={client}><Probe slot="hero" /></VendoProvider>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("app_2"));
  });

  it("reports no app when nothing is pinned to the slot", async () => {
    vi.spyOn(client.apps, "list").mockResolvedValue([pinnedApp({ pins: [] })]);
    render(<VendoProvider client={client}><Probe slot="hero" /></VendoProvider>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("none"));
  });

  it("keeps polling on the configured interval so a new pin appears on its own", async () => {
    const list = vi.spyOn(client.apps, "list").mockResolvedValue([]);
    render(<VendoProvider client={client}><Probe slot="hero" pollMs={20} /></VendoProvider>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("none"));
    list.mockResolvedValue([pinnedApp()]);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("app_1"));
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  it("VendoSlot discovers its own pin when no appId/pin prop is passed", async () => {
    vi.spyOn(client.apps, "list").mockResolvedValue([pinnedApp()]);
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    // The host children render immediately; the discovered app then mounts
    // through the normal app path (opened over the wire).
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
  });

  it("VendoSlot leaves children untouched when nothing is pinned", async () => {
    vi.spyOn(client.apps, "list").mockResolvedValue([pinnedApp({ pins: [] })]);
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    await waitFor(() => expect(client.apps.list).toHaveBeenCalled());
    expect(screen.getByText("Original hero")).toBeTruthy();
    expect(screen.queryByText("Invoices app surface")).toBeNull();
  });

  it("an explicit appId prop wins over discovery (no polling dance started)", async () => {
    const list = vi.spyOn(client.apps, "list");
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" appId="app_1"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });
});
