// @vitest-environment jsdom
// The greeting on VendoPage: the page mounts its thread with threadId
// undefined BEFORE the sidebar list resolves, so without gating the one-time
// greeting would burn (or flash) during that transient for returning users.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoPage } from "../../src/chrome/index.js";
import { hasSeen } from "../../src/chrome/discoverability.js";
import { createWireServer } from "../wire-server.js";

describe("greeting-as-tutorial on VendoPage", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    window.localStorage.clear();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  const intro = () => screen.queryByText(/reshape a screen to fit how you work/i);

  it("returning user: no tutorial during the auto-select transient and no burned flag; explicit New conversation is the first open", async () => {
    render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    // The fixture conversation loads and auto-selects into the transcript.
    expect(await screen.findByText("Existing thread")).toBeTruthy();
    expect(intro()).toBeNull();
    // The transient empty mount must NOT have burned the once-ever flag.
    expect(hasSeen("greeting")).toBe(false);
    // The user's first actually-fresh conversation shows the tutorial once.
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(intro()).toBeTruthy());
    expect(hasSeen("greeting")).toBe(true);
  });

  it("brand-new user (no conversations): the settled empty landing shows the tutorial", async () => {
    vi.spyOn(client.threads, "list").mockResolvedValue([]);
    render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    await waitFor(() => expect(intro()).toBeTruthy());
    expect(hasSeen("greeting")).toBe(true);
  });
});
