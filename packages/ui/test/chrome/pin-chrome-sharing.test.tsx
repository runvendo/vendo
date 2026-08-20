// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** The ✦ menu's fourth item. One toggle, one tenant, viewer level — and it is
 *  simply absent when there is nothing to share with. */
describe("the ✦ share toggle", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
    await client.apps.place("app_1", "hero");
  });
  afterEach(async () => { cleanup(); await wire.close(); });

  const openMenu = async () => {
    const pill = await screen.findByRole("button", { name: "Edit Invoices" });
    fireEvent.click(pill);
  };

  /** Absence is only news AFTER the read has answered. Without this wait both
   *  "is absent" cases assert against a menu that has simply not heard back
   *  yet — they passed against a hook with the owner check deleted. */
  const grantsRead = () =>
    waitFor(() => expect(wire.requests.some((request) => request.path === "/apps/app_1/grants")).toBe(true));

  it("offers the owner's own tenant by NAME, off, between Update and Revert", async () => {
    wire.setGrants("app_1", { level: "owner", grants: [], orgs: [{ org: "acme", display: "Acme Corp" }] });
    render(<VendoProvider client={client}><VendoSlot id="hero" /><VendoOverlay launcher="none" /></VendoProvider>);
    await openMenu();
    const item = await screen.findByRole("button", { name: "Share with Acme Corp" });
    expect(item.getAttribute("aria-pressed")).toBe("false");
    const labels = [...item.closest(".fl-remix-menu")!.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Edit in chat", "Update", "Share with Acme Corp", "Revert"]);
  });

  it("reads as ON when the grant is already there", async () => {
    wire.setGrants("app_1", {
      level: "owner",
      grants: [{ id: "g1", appId: "app_1", orgId: "acme", principal: "org:acme", level: "viewer", createdBy: "alice", createdAt: "2026-08-01T00:00:00.000Z" }],
      orgs: [{ org: "acme", display: "Acme Corp" }],
    });
    render(<VendoProvider client={client}><VendoSlot id="hero" /><VendoOverlay launcher="none" /></VendoProvider>);
    await openMenu();
    await waitFor(async () =>
      expect((await screen.findByRole("button", { name: "Share with Acme Corp" })).getAttribute("aria-pressed")).toBe("true"));
  });

  it("writes the grant when switched on", async () => {
    wire.setGrants("app_1", { level: "owner", grants: [], orgs: [{ org: "acme", display: "Acme Corp" }] });
    render(<VendoProvider client={client}><VendoSlot id="hero" /><VendoOverlay launcher="none" /></VendoProvider>);
    await openMenu();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Acme Corp" }));
    await waitFor(() => expect(wire.grantsOf("app_1")).toEqual([
      expect.objectContaining({ principal: "org:acme", level: "viewer" }),
    ]));
  });

  it("revokes when switched off", async () => {
    wire.setGrants("app_1", {
      level: "owner",
      grants: [{ id: "g1", appId: "app_1", orgId: "acme", principal: "org:acme", level: "viewer", createdBy: "alice", createdAt: "2026-08-01T00:00:00.000Z" }],
      orgs: [{ org: "acme", display: "Acme Corp" }],
    });
    render(<VendoProvider client={client}><VendoSlot id="hero" /><VendoOverlay launcher="none" /></VendoProvider>);
    await openMenu();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Acme Corp" }));
    await waitFor(() => expect(wire.grantsOf("app_1")).toEqual([]));
  });

  it("is absent for a non-owner", async () => {
    wire.setGrants("app_1", { level: "viewer", grants: [], orgs: [{ org: "acme", display: "Acme Corp" }] });
    render(<VendoProvider client={client}><VendoSlot id="hero" /><VendoOverlay launcher="none" /></VendoProvider>);
    await grantsRead();
    await openMenu();
    await screen.findByRole("button", { name: "Revert" });
    expect(screen.queryByRole("button", { name: /^Share with/ })).toBeNull();
  });

  it("is absent for an owner in no tenant", async () => {
    wire.setGrants("app_1", { level: "owner", grants: [], orgs: [] });
    render(<VendoProvider client={client}><VendoSlot id="hero" /><VendoOverlay launcher="none" /></VendoProvider>);
    await grantsRead();
    await openMenu();
    await screen.findByRole("button", { name: "Revert" });
    expect(screen.queryByRole("button", { name: /^Share with/ })).toBeNull();
  });
});
