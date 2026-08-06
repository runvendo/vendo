// @vitest-environment jsdom
// Slot self-discovery, on placement ROWS (2026-08-05): the slot resolves "the
// app placed in slot X" and where that app's build stands, through ONE shared
// poller per client — every mounted slot rides the same GET /apps/placements.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, useSlotApp, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

const entry = (overrides: Partial<{ slot: string; app: string; title: string; status: string }> = {}) => ({
  slot: "hero",
  app: "app_1",
  title: "Invoices",
  status: "ready" as const,
  ...overrides,
});

describe("Slot self-discovery (useSlotApp + VendoSlot) over placement rows", () => {
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

  function Probe({ slot }: { slot: string }) {
    const { appId, status, isLoading } = useSlotApp(slot);
    return <output>{isLoading ? "loading" : `${appId ?? "none"}:${status ?? "none"}`}</output>;
  }

  it("resolves the app placed in the slot, over the real wire", async () => {
    await client.apps.place("app_1", "hero");
    render(<VendoProvider client={client}><Probe slot="hero" /></VendoProvider>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("app_1:ready"));
  });

  it("reports no app when nothing is placed in the slot", async () => {
    render(<VendoProvider client={client}><Probe slot="hero" /></VendoProvider>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("none:none"));
  });

  it("carries a build that has not landed as building, with its id", async () => {
    vi.spyOn(client.apps, "placements").mockResolvedValue([
      entry({ app: "app_forming", title: "", status: "building" }),
    ]);
    render(<VendoProvider client={client}><Probe slot="hero" /></VendoProvider>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("app_forming:building"));
  });

  it("asks for EVERY mounted slot in ONE request, and keeps polling", async () => {
    const placements = vi.spyOn(client.apps, "placements").mockResolvedValue([]);
    render(
      <VendoProvider client={client}>
        <Probe slot="hero" />
        <Probe slot="sidebar" />
      </VendoProvider>,
    );
    await waitFor(() => {
      const asked = placements.mock.calls.at(-1)?.[0] ?? [];
      expect([...asked].sort()).toEqual(["hero", "sidebar"]);
    });
    // A placement made anywhere else appears on the poll's own cadence…
    placements.mockResolvedValue([entry()]);
    await waitFor(
      () => expect(screen.getAllByRole("status")[0]?.textContent).toBe("app_1:ready"),
      { timeout: 25_000 },
    );
    // …and no request ever asked for a single slot on its own: one poller,
    // every mounted slot, one request per tick.
    for (const [asked] of placements.mock.calls) {
      expect([...(asked ?? [])].sort()).toEqual(["hero", "sidebar"]);
    }
  });

  it("VendoSlot mounts the placed app when it is READY", async () => {
    vi.spyOn(client.apps, "placements").mockResolvedValue([entry()]);
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
  });

  it("VendoSlot keeps the host's children while the placed build is still forming", async () => {
    vi.spyOn(client.apps, "placements").mockResolvedValue([
      entry({ app: "app_forming", title: "", status: "building" }),
    ]);
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    await waitFor(() => expect(client.apps.placements).toHaveBeenCalled());
    expect(screen.getByText("Original hero")).toBeTruthy();
    expect(screen.queryByText("Invoices app surface")).toBeNull();
  });

  it("VendoSlot leaves children untouched when nothing is placed", async () => {
    vi.spyOn(client.apps, "placements").mockResolvedValue([]);
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    await waitFor(() => expect(client.apps.placements).toHaveBeenCalled());
    expect(screen.getByText("Original hero")).toBeTruthy();
  });

  it("discover={false} stands discovery down (host polls itself)", async () => {
    const placements = vi.spyOn(client.apps, "placements");
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" discover={false}><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    expect(screen.getByText("Original hero")).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(placements).not.toHaveBeenCalled();
  });

  it("an explicit appId prop wins over discovery (no poll started)", async () => {
    const placements = vi.spyOn(client.apps, "placements");
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" appId="app_1"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
    expect(placements).not.toHaveBeenCalled();
  });
});
