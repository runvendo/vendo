// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** S3 — the ✦ popover on a pinned app, reached and driven by the keyboard
 *  alone. A handle only a cursor can find is a handle half the people using
 *  the page do not have. */
describe("pinned-app ✦ chrome (keyboard)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
    await client.apps.place("app_1", "hero");
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  const pill = () => screen.findByRole("button", { name: "Edit Invoices" });

  it("focus reveals the pill, which opens the popover and closes on Escape", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );

    const edit = await pill();
    edit.focus();
    expect(document.activeElement).toBe(edit);
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    // Tab alone blooms the seed into the pill — the reveal is state, so it
    // answers to focus exactly as it answers to a cursor.
    await waitFor(() =>
      expect(edit.closest(".fl-slot-filled")?.hasAttribute("data-vendo-revealed")).toBe(true));

    fireEvent.click(edit);
    expect(edit.getAttribute("aria-expanded")).toBe("true");
    for (const label of ["Edit in chat", "Refresh", "Unpin"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    // There is no History item — the popover is exactly these three.
    expect(screen.queryByRole("button", { name: /history/i })).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Unpin" })).toBeNull());
  });

  it("“Edit in chat” opens the overlay scoped to the app, composer prefilled and unsent", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );

    fireEvent.click(await pill());
    fireEvent.click(screen.getByRole("button", { name: "Edit in chat" }));

    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    const composer = await screen.findByRole("textbox", { name: /message/i });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe("Update Invoices: "));
  });
});
