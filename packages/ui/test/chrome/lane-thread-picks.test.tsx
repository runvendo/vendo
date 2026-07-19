// @vitest-environment jsdom
/** Lane picks (ui-lane-thread converged set) — the surfaces new in this wave:
    4B starter cards on the landing and the 2C focus-bloom hint row. The other
    picks are covered where their old behaviors were asserted (ribbon in
    thread-and-overlay, sources collapse in tool-humanization, thread-wide
    drop + chip read states in affordances-eng225). */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("lane pick 4B — landing starter cards", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    window.localStorage.clear();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });
  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  it("renders object suggestions as two-line cards and sends the prompt on tap", async () => {
    render(
      <VendoProvider client={client}>
        <VendoThread
          discoverability="quiet"
          suggestions={[
            { title: "Build a view", description: "Renewals sorted by risk", prompt: "Build me a renewals view" },
            { title: "Automate a chore", description: "Post the digest every Monday" },
          ]}
        />
      </VendoProvider>,
    );
    const card = await screen.findByRole("button", { name: /Build a view/ });
    expect(card.className).toContain("fl-card");
    expect(card.textContent).toContain("Renewals sorted by risk");
    // The second card falls back to its title as the prompt.
    expect(screen.getByRole("button", { name: /Automate a chore/ })).toBeTruthy();
    fireEvent.click(card);
    // The card SENDS (it is a starter, not a prefill): the message rides the
    // card's explicit prompt, not its title.
    await waitFor(() => {
      const post = wire.requests.find(request => request.method === "POST" && request.path === "/threads");
      expect(post?.body).toMatchObject({
        message: { role: "user", parts: [{ type: "text", text: "Build me a renewals view" }] },
      });
    });
  });

  it("keeps plain string suggestions as pill chips (back-compat)", async () => {
    render(
      <VendoProvider client={client}>
        <VendoThread discoverability="quiet" suggestions={["Chase overdue invoices"]} />
      </VendoProvider>,
    );
    const chip = await screen.findByRole("button", { name: "Chase overdue invoices" });
    expect(chip.className).toContain("fl-chip");
    expect(document.querySelector(".fl-card")).toBeNull();
  });
});

describe("lane pick 2C — composer focus-bloom hint row", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    window.localStorage.clear();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });
  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  it("mounts the hint row inside the composer (visibility is CSS :focus-within)", async () => {
    render(<VendoProvider client={client}><VendoThread discoverability="quiet" /></VendoProvider>);
    await screen.findByRole("form", { name: "Message composer" });
    const hintrow = document.querySelector(".fl-hintrow");
    expect(hintrow).toBeTruthy();
    expect(hintrow?.textContent).toContain("new line");
    expect(hintrow?.textContent).toContain("drop files anywhere");
    // Presentation-only: hidden from the tree (reveal is a pure CSS bloom).
    expect(hintrow?.getAttribute("aria-hidden")).toBe("true");
  });
});
