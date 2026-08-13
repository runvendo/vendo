// @vitest-environment jsdom
// ENG-388 F10 — overlay conversation history + resumption: the header's
// previous-conversations picker, origin-scoped last-thread persistence, and
// restore-on-mount (a reload no longer silently discards the conversation).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

const LAST_THREAD_KEY = "vendo:last-thread";

describe("VendoOverlay conversation history (F10)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    window.localStorage.clear();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  const mount = () =>
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);

  /** Type into the visible composer and send; waits for the streamed reply. */
  const sendMessage = async (text: string, turns = 1) => {
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("Turn complete")).toHaveLength(turns));
  };

  const historyButton = () => screen.getByRole("button", { name: "Previous conversations" });

  it("offers Previous conversations in the header", () => {
    mount();
    expect(historyButton()).toBeTruthy();
    expect(historyButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the picker listing prior conversations; Cancel returns without switching", async () => {
    mount();
    fireEvent.click(historyButton());
    // The seeded thread appears as a row, titled from its first message.
    await screen.findByRole("button", { name: /Existing thread/ });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: /Existing thread/ })).toBeNull();
    // Still the fresh landing: composer present, no transcript loaded.
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(screen.queryByText("Existing thread")).toBeNull();
  });

  it("Escape closes the picker, not the overlay", async () => {
    mount();
    fireEvent.click(historyButton());
    const row = await screen.findByRole("button", { name: /Existing thread/ });
    fireEvent.keyDown(row, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /Existing thread/ })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
  });

  it("resumes a picked conversation in place and remembers it", async () => {
    mount();
    fireEvent.click(historyButton());
    fireEvent.click(await screen.findByRole("button", { name: /Existing thread/ }));
    // The picked thread's transcript loads into the conversation...
    await waitFor(() => expect(screen.getByText("Existing thread")).toBeTruthy());
    // ...the picker is gone, and the pick is the remembered conversation.
    expect(screen.queryByRole("button", { name: /Existing thread/ })).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem(LAST_THREAD_KEY)).toBe("thr_1"));
  });

  it("does not offer the active conversation as previous", async () => {
    mount();
    await sendMessage("hello history");
    fireEvent.click(historyButton());
    await screen.findByRole("button", { name: /Existing thread/ });
    expect(screen.queryByRole("button", { name: /hello history/ })).toBeNull();
  });

  it("remembers the conversation and resumes it on a fresh mount", async () => {
    const first = mount();
    await sendMessage("resume me");
    await waitFor(() => expect(window.localStorage.getItem(LAST_THREAD_KEY)).toBe("thr_minted"));
    first.unmount();
    mount();
    // The prior conversation is back without any interaction.
    await waitFor(() => expect(screen.getByText("resume me")).toBeTruthy());
  });

  it("falls back to a fresh conversation when the remembered one is gone", async () => {
    window.localStorage.setItem(LAST_THREAD_KEY, "thr_gone");
    mount();
    // Wait for the self-heal to settle (useVendoThread lists threads, finds
    // thr_gone missing, and clears it) before interacting — a human cannot
    // type before this round trip lands, and sending mid-heal would race the
    // turn onto the stale id.
    await waitFor(() => expect(
      wire.requests.some(request => request.method === "GET" && request.path === "/threads"),
    ).toBe(true));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy());
    expect(screen.queryByText("Existing thread")).toBeNull();
    // The healed surface is fully usable: sending mints a fresh thread and
    // the fresh mint replaces the stale remembered id.
    await sendMessage("fresh start");
    await waitFor(() => expect(window.localStorage.getItem(LAST_THREAD_KEY)).toBe("thr_minted"));
  });

  it("ignores a malformed stored id entirely", async () => {
    window.localStorage.setItem(LAST_THREAD_KEY, "not-a-thread");
    mount();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy());
    expect(wire.requests.filter(request => request.path === "/threads/not-a-thread")).toHaveLength(0);
  });

  it("New conversation forgets the remembered conversation", async () => {
    mount();
    await sendMessage("to be forgotten");
    await waitFor(() => expect(window.localStorage.getItem(LAST_THREAD_KEY)).toBe("thr_minted"));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(window.localStorage.getItem(LAST_THREAD_KEY)).toBeNull();
  });
});
