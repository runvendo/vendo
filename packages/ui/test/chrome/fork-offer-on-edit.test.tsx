// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoPage } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/**
 * Build contract §9.4 — `forbidden` exists for exactly one case: a caller who
 * provably SEES the app is denied a change. That case is answerable, and the
 * consumer-voice fork offer is the answer ("I can't change the team's copy, but
 * I can make you your own").
 *
 * The offer was mounted only off the REMOVE button, so the verb the code was
 * invented for — the edit — showed the raw refusal string instead.
 *
 * ONE server and ONE VendoPage render for the whole file, deliberately: a
 * per-case wire server plus a full page mount is heavy enough that vitest's
 * parallel workers starved workspace-palette-slot.test.tsx's 10s waits. The same
 * flow is also proven in a real browser (e2e/wave3-consumer-voice.spec.ts).
 */
describe("the fork offer answers an EDIT a viewer may not make", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeAll(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterAll(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  /** The named card, so a sibling app can never be the one under test. */
  const invoicesCard = (): HTMLElement => screen.getAllByRole("article")
    .find((card) => card.textContent?.includes("Invoices"))!;

  const askForAChange = (asked: string): void => {
    const card = within(invoicesCard());
    // A refused change leaves the box OPEN with what they typed still in it —
    // they can retry or take the offer — so the second ask reuses it rather
    // than looking for a "Change" button that now reads "Cancel change".
    if (card.queryByRole("form", { name: "Change Invoices" }) === null) {
      fireEvent.click(card.getByRole("button", { name: "Change" }));
    }
    const field = card.getByRole("form", { name: "Change Invoices" })
      .querySelector("input") as HTMLInputElement;
    fireEvent.change(field, { target: { value: asked } });
    fireEvent.click(card.getByRole("button", { name: "Save" }));
  };

  it("offers the fork in the person's own words, forks on request, and leaves other failures alone", async () => {
    const refuse = (code: string, message: string): void => {
      vi.spyOn(client.apps, "edit").mockRejectedValue(Object.assign(new Error(message), { code }));
    };
    refuse("forbidden", "editor access is required for app_1");
    const forked = vi.spyOn(client.apps, "fork");

    render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
    await screen.findByText("Invoices", {}, { timeout: 12000 });

    // 1 — the refusal becomes an offer, carrying what they actually asked for
    // ("friendly is not vague") and naming neither the level nor the app id.
    askForAChange("show last quarter too");
    const offer = await screen.findByText(/I can’t change the team’s copy/i, {}, { timeout: 12000 });
    expect(offer.textContent).toContain("show last quarter too");
    expect(screen.queryByText(/editor access is required/)).toBeNull();

    // 2 — taking the offer makes them their own copy.
    fireEvent.click(screen.getByRole("button", { name: "Make me my own copy" }));
    await waitFor(() => expect(forked).toHaveBeenCalledWith("app_1"));
    await waitFor(() => expect(screen.queryByText(/I can’t change the team’s copy/i)).toBeNull());

    // 3 — the offer is for `forbidden` ALONE. Anything else is not "you may not",
    // so answering it with "want your own copy?" would be a lie. It is still
    // answered in the CONSUMER's voice: the page used to render the server's own
    // sentence verbatim (`refusalCopy`'s treatment reached the Share dialog and
    // never the page), which put "app not found: app_1" on a bank customer's
    // screen.
    refuse("unavailable", "the model is unavailable");
    askForAChange("add a chart");
    const alert = await screen.findByRole("alert", {}, { timeout: 12000 });
    expect(alert.textContent).not.toContain("the model is unavailable");
    expect(alert.textContent).toMatch(/didn’t go through/i);
    expect(screen.queryByText(/I can’t change the team’s copy/i)).toBeNull();

    // 4 — and the developer-voice ones the page could always raise: an app id,
    // and a sentence naming an environment variable.
    refuse("not-found", "app not found: app_1");
    askForAChange("rename it");
    await waitFor(() => {
      const shown = screen.getByRole("alert").textContent ?? "";
      expect(shown).not.toContain("app_1");
      expect(shown).toMatch(/isn’t available/i);
    });

    refuse("cloud-required", "sharing needs Vendo Cloud: set VENDO_API_KEY");
    askForAChange("share it");
    await waitFor(() => {
      const shown = screen.getByRole("alert").textContent ?? "";
      expect(shown).not.toMatch(/VENDO_API_KEY|Vendo Cloud/);
      expect(shown).toMatch(/isn’t turned on/i);
    });
  });
});
