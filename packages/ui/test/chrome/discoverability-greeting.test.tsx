// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoThread } from "../../src/chrome/index.js";
import { hasSeen } from "../../src/chrome/discoverability.js";
import { createWireServer } from "../wire-server.js";

describe("greeting-as-tutorial (ui-usage-dx §6 — first-open discoverability)", () => {
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

  const intro = () => screen.queryByText(/reshape a screen to fit how you work/i);

  /** Wire traffic minus ChromeRoot's mount-time guard-posture probe
   *  (GET /status) — baseline for ANY thread render, greeting or not. The
   *  greeting invariant is that IT adds nothing: no thread create, no send,
   *  no persistence. */
  const nonBaselineRequests = () =>
    wire.requests.filter(request => !(request.method === "GET" && request.path === "/status"));

  it("renders the default greeting on a first-ever fresh conversation, marks seen, fires NO transport calls", async () => {
    render(<VendoProvider client={client}><VendoThread /></VendoProvider>);
    await waitFor(() => expect(intro()).toBeTruthy());
    // 2–3 tappable prompts, one always a molding prompt.
    const chips = screen.getAllByRole("button", { name: /./ }).filter(b => b.className.includes("fl-chip"));
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.some(chip => /rebuild this page/i.test(chip.textContent ?? ""))).toBe(true);
    // Fire-once is burned on first render, not on interaction.
    expect(hasSeen("greeting")).toBe(true);
    // Presentation-only: rendering the greeting adds ZERO wire traffic — it is
    // never persisted to the thread and never sent to the model.
    expect(nonBaselineRequests()).toHaveLength(0);
  });

  it("chip tap PREFILLS the composer and never sends", async () => {
    render(<VendoProvider client={client}><VendoThread /></VendoProvider>);
    await waitFor(() => expect(intro()).toBeTruthy());
    const chip = screen.getAllByRole("button", { name: /./ }).filter(b => b.className.includes("fl-chip"))[0]!;
    fireEvent.click(chip);
    const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(composer.value).toBe(chip.textContent);
    // Still zero added wire traffic: no thread create, no message send.
    expect(nonBaselineRequests()).toHaveLength(0);
    // And nothing was persisted locally as a fake transcript either — the
    // greeting block is the only assistant-style content on screen.
    expect(document.querySelectorAll(".fl-turn-user, .fl-turn-assistant")).toHaveLength(0);
  });

  it("renders once per user EVER: a simulated reload gets the plain landing", async () => {
    render(<VendoProvider client={client}><VendoThread /></VendoProvider>);
    await waitFor(() => expect(intro()).toBeTruthy());
    cleanup();
    render(<VendoProvider client={client}><VendoThread /></VendoProvider>);
    // Plain landing headline, no tutorial block.
    expect(screen.getByText("What can I help you build?")).toBeTruthy();
    expect(intro()).toBeNull();
  });

  it("shows no greeting on a thread that has history, without burning the flag", async () => {
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();
    expect(intro()).toBeNull();
    // An adopted thread is not a first conversation open — the user still gets
    // their one greeting on the first fresh conversation.
    expect(hasSeen("greeting")).toBe(false);
  });

  it("discoverability=\"quiet\" (provider) disables the greeting without burning the flag", async () => {
    render(
      <VendoProvider client={client} discoverability="quiet">
        <VendoThread />
      </VendoProvider>,
    );
    expect(screen.getByText("What can I help you build?")).toBeTruthy();
    expect(intro()).toBeNull();
    expect(hasSeen("greeting")).toBe(false);
  });

  it("host-supplied greeting config (provider prop) replaces the default", async () => {
    render(
      <VendoProvider
        client={client}
        greeting={{ intro: "Welcome to Cadence — your books, your way.", prompts: ["Show unpaid invoices", "Redesign my dashboard"] }}
      >
        <VendoThread />
      </VendoProvider>,
    );
    expect(await screen.findByText("Welcome to Cadence — your books, your way.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show unpaid invoices" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Redesign my dashboard" })).toBeTruthy();
  });

  it("reaches the overlay's thread, honoring the overlay-level greeting prop", async () => {
    render(
      <VendoProvider client={client}>
        <VendoOverlay defaultOpen greeting={{ intro: "Overlay says hi.", prompts: ["Mold this app"] }} />
      </VendoProvider>,
    );
    expect(await screen.findByText("Overlay says hi.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mold this app" })).toBeTruthy();
  });
});
