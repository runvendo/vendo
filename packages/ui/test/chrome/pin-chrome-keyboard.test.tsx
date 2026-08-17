// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoSlot, VendoToasts, dismissAllVendoToasts } from "../../src/chrome/index.js";
import { featuredEmbed, initialSplitViewState, splitViewReducer } from "../../src/chrome/split-view.js";
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
    dismissAllVendoToasts();
    vi.restoreAllMocks();
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

  it("a refused unpin says so and stays retryable — it never settles as done", async () => {
    const refused = vi.spyOn(client.apps, "unplace").mockRejectedValue(new Error("nope"));
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" />
        <VendoToasts />
      </VendoProvider>,
    );

    fireEvent.click(await pill());
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));

    // The row is still there, so the popover is too — with Unpin under the
    // cursor where the person left it.
    expect(await screen.findByText(/didn.t go through/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin" }).hasAttribute("disabled")).toBe(false));
    expect(refused).toHaveBeenCalledWith("app_1", "hero");
  });
});

/** "Edit in chat" promises the overlay is scoped to THAT app. A pinned app lives
 *  in a host slot, so the conversation has never embedded it — and a pick for an
 *  app with no embed used to be dropped on the floor, leaving whatever was
 *  already on the stage there while the composer named the pinned one. Showing
 *  one app and talking about another is worse than either alone. */
describe("the workspace pick a pinned app's ✦ makes", () => {
  const viewOf = (appId: string) =>
    ({ type: "embed", appId, payload: { formatVersion: "vendo-genui/v2" } }) as const;

  it("never leaves a different app on the stage", () => {
    // A conversation that already put a view on the stage.
    const other = splitViewReducer(initialSplitViewState, viewOf("app_other"));
    expect(featuredEmbed(other)?.appId).toBe("app_other");

    // ✦ Edit in chat on the pinned app — one this thread has never embedded.
    const picked = splitViewReducer(other, { type: "feature", appId: "app_pinned" });
    expect(picked.selectedAppId).toBe("app_pinned");
    expect(featuredEmbed(picked)?.appId).not.toBe("app_other");
    expect(featuredEmbed(picked)).toBeUndefined();

    // And the moment the edit gives that app a view, it is the one on the stage.
    expect(featuredEmbed(splitViewReducer(picked, viewOf("app_pinned")))?.appId).toBe("app_pinned");
  });
});
