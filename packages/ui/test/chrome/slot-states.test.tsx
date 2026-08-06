// @vitest-environment jsdom
// The slot's own build vocabulary. A placement row is written the moment the app
// id is minted, so the slot knows it is about to be filled while the build is
// still streaming — and says so, in the skeleton the empty state already uses.
// Everything here goes over the fixture wire: the states are read from real
// /apps/placements answers, never from a stubbed hook.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { BUILD_FAILURE_COPY } from "../../src/chrome/thread/message-data.js";
import { createWireServer } from "../wire-server.js";

describe("VendoSlot build states", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    window.localStorage.clear();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    // Unmount BEFORE closing the wire: a still-mounted slot keeps polling into
    // the closing server and server.close() livelocks to the hook timeout.
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  const slot = (id: string) => render(
    <VendoProvider client={client}>
      <VendoSlot id={id}><span>Original hero</span></VendoSlot>
    </VendoProvider>,
  );

  describe("building", () => {
    it("shows a skeleton in the slot while the placed build is still streaming", async () => {
      wire.state.placements.push({ slot: "hero", appId: "app_minting" });
      slot("hero");
      const beat = await screen.findByRole("status");
      expect(beat.textContent).toContain("Building your view");
      // The host's markup gives way — the slot is committed to this app.
      expect(screen.queryByText("Original hero")).toBeNull();
    });

    it("mounts the app in place the moment the build lands — no remount, no reload", async () => {
      wire.state.placements.push({ slot: "hero", appId: "app_lands" });
      wire.state.landingApps.set("app_lands", { remaining: 2, name: "Trip planner" });
      slot("hero");
      expect((await screen.findByRole("status")).textContent).toContain("Building your view");
      expect(await screen.findByText("Trip planner app surface")).toBeTruthy();
    });
  });
});
