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
    // A slot with host markup of its own KEEPS it while a build forms — a
    // working host component never blanks into a skeleton for the length of a
    // build (pinned by slot-discovery.test.tsx). The beat below is the empty
    // slot's: it had only an invitation to give up.
    const emptySlot = (id: string) => render(
      <VendoProvider client={client}><VendoSlot id={id} /></VendoProvider>,
    );

    it("shows a skeleton in an empty slot while the placed build is still streaming", async () => {
      wire.state.placements.push({ slot: "hero", appId: "app_minting" });
      emptySlot("hero");
      const beat = await screen.findByRole("status");
      expect(beat.textContent).toContain("Building your view");
      // The invitation gives way — there is nothing to ask for any more.
      expect(screen.queryByText("This space builds itself")).toBeNull();
    });

    it("mounts the app in place the moment the build lands — no remount, no reload", async () => {
      wire.state.placements.push({ slot: "hero", appId: "app_lands" });
      wire.state.landingApps.set("app_lands", { after: 2, seen: 0, name: "Trip planner" });
      emptySlot("hero");
      expect((await screen.findByRole("status")).textContent).toContain("Building your view");
      expect(await screen.findByText("Trip planner app surface")).toBeTruthy();
    });
  });

  describe("failed", () => {
    // A real sentence the wire carries. It names the thing that has to change,
    // so it is what the slot prints — a canned line would leave a host's most
    // public surface saying nothing anyone can act on.
    const buildReason = "This app wasn't created, because it didn't pass the checks that keep an app honest:"
      + " the `value` expression is a declarative string that the DataTable does not evaluate,"
      + " not JavaScript: amount / sum(spending.data.amount)";

    function doomed(retryable: boolean, prompt?: string) {
      wire.state.failedApps.set("app_doomed", {
        reason: buildReason,
        retryable,
        ...(prompt === undefined ? {} : { prompt }),
      });
      wire.state.placements.push({ slot: "hero", appId: "app_doomed" });
    }

    it("says the reason the wire carried, whole", async () => {
      doomed(true, "a spending board");
      slot("hero");
      await screen.findByText(buildReason);
      const rendered = document.querySelector<HTMLElement>("[data-vendo-slot]")?.textContent ?? "";
      expect(rendered).toContain(buildReason);
    });

    it("offers a retry that re-issues the ORIGINAL request and takes the slot", async () => {
      doomed(true, "a spending board");
      slot("hero");
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => expect(
        wire.state.placements.find(row => row.slot === "hero")?.appId,
      ).not.toBe("app_doomed"));
      // The fixture names a created app after its prompt, so the mounted app is
      // provably the re-issued request and not the failed record.
      expect(await screen.findByText("a spending board app surface")).toBeTruthy();
    });

    it("offers no retry when the failure is not retryable — never a button that lies", async () => {
      doomed(false, "a spending board");
      slot("hero");
      await screen.findByText(buildReason);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByRole("button", { name: "Clear this slot" })).toBeTruthy();
    });

    it("offers no retry when the record kept no request — there is nothing honest to re-issue", async () => {
      doomed(true);
      slot("hero");
      await screen.findByText(buildReason);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    // By design, and not a bug: the failed arm REPLACES the host's markup, which
    // is what makes "Try again" and "Clear this slot" reachable at all. The
    // building/failed asymmetry is deliberate — do not add a case asking failure
    // to sit behind children.

    it("clearing the slot unplaces the app and gives the host its own markup back", async () => {
      doomed(false, "a spending board");
      slot("hero");
      fireEvent.click(await screen.findByRole("button", { name: "Clear this slot" }));
      await waitFor(() => expect(wire.state.placements.some(row => row.slot === "hero")).toBe(false));
      expect(await screen.findByText("Original hero")).toBeTruthy();
    });
  });

  describe("ready", () => {
    it("mounts the placed app — the tree surface", async () => {
      wire.state.placements.push({ slot: "hero", appId: "app_1" });
      slot("hero");
      expect(await screen.findByText("Invoices app surface")).toBeTruthy();
    });

    // The build landed, so the placement says "ready" and the app mounts — and
    // the open answers that its screen is gone. Only the mounted surface knows,
    // so the failed card has to be reachable from there too.
    it("shows the failed card when a ready app's screen no longer opens", async () => {
      const reason = "the screen no longer compiles: spending.data is undefined";
      wire.state.deadScreens.set("app_1", reason);
      wire.state.placements.push({ slot: "hero", appId: "app_1" });
      slot("hero");
      await screen.findByText(reason);
      expect(screen.getByRole("button", { name: "Clear this slot" })).toBeTruthy();
    });

    // A host-asserted appId is the host's own markup decision: there is no
    // placement row to clear, and discovery is stood down, so the card's writes
    // would land on the wire and change nothing on screen. The reason is still
    // said — in the notice the frame renders for every one of its callers.
    it("a host-asserted app says why, without a clear that could never land", async () => {
      const reason = "the screen no longer compiles: spending.data is undefined";
      wire.state.deadScreens.set("app_1", reason);
      render(
        <VendoProvider client={client}>
          <VendoSlot id="hero" appId="app_1"><span>Original hero</span></VendoSlot>
        </VendoProvider>,
      );
      await screen.findByText(reason);
      expect(screen.queryByRole("button", { name: "Clear this slot" })).toBeNull();
    });
  });
});
