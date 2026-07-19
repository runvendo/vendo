// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoPage } from "../../src/chrome/index.js";
import { markSeen } from "../../src/chrome/discoverability.js";
import { createWireServer } from "../wire-server.js";

// ENG-222 — the page's thread sidebar never refreshed, so a conversation
// started via "New conversation" (which mints a fresh thr_ id server-side)
// never appeared in the list. It must refresh once the new thread is minted.
describe("VendoPage thread sidebar refresh", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
    // This test asserts the RETURNING-user landing heading after "New
    // conversation"; a first-ever fresh conversation would show the one-time
    // greeting-as-tutorial instead (discoverability §6), so mark it seen.
    markSeen("greeting");
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  it("surfaces a newly started conversation in the sidebar after its first turn", async () => {
    render(<VendoProvider client={client}><VendoPage /></VendoProvider>);

    // The existing fixture conversation loads into the sidebar first. Explicit
    // 12s timeout (not the 1s default): under CI coverage instrumentation the
    // initial threads-list fetch + render can exceed a second (pre-existing
    // turbo-parallel/coverage-load flake). 12s (not main's 4s) because a 4s
    // window still flaked in this branch's CI runs.
    await waitFor(
      () => expect(screen.getAllByRole("button", { name: "Fixture thread" })).toHaveLength(1),
      { timeout: 12000 },
    );

    // Start a fresh conversation; the landing greeting confirms we're on a new
    // (empty) thread and the auto-select won't snap us back to the fixture one.
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByRole("heading", { name: "What can I help you build?" }, { timeout: 12000 })).toBeTruthy();

    // Send the first turn via the Send button once it enables, so the turn can't
    // be dropped by a not-yet-flushed draft on the keydown path.
    const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Kick off a new conversation" } });
    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false), { timeout: 12000 });
    fireEvent.click(send);

    // Confirm the turn actually posted (mints the thr_) before asserting the
    // downstream sidebar refresh — never a bare check after the async send.
    await waitFor(
      () => expect(wire.requests.some(r => r.method === "POST" && r.path === "/threads")).toBe(true),
      { timeout: 12000 },
    );
    // The minted thread now appears in the sidebar (previously it never did) —
    // this rides the server round-trip (mint header → refresh → GET /threads).
    await waitFor(
      () => expect(screen.getAllByRole("button", { name: "Fixture thread" })).toHaveLength(2),
      { timeout: 12000 },
    );
  });
});
