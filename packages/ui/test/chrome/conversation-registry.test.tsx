// @vitest-environment jsdom
// PR #361 triage — the conversation-opening registry hardened:
// 1. public seam is openVendoConversation (orchestrator rename);
// 2. newConversation + prompt lands in the FRESH thread, not the composer
//    about to unmount (Greptile P1 / Devin);
// 3. a prompt targets the opened overlay's own composer, not whichever
//    composer registered last (Devin cross-surface finding).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoThread, openVendoConversation } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("openVendoConversation registry", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  const dialog = () => screen.getByRole("dialog", { name: "Vendo assistant" });

  it("reports false with no overlay mounted", () => {
    expect(openVendoConversation({ prompt: "anything" })).toBe(false);
  });

  it("delivers a newConversation prompt to the fresh thread, not the outgoing composer", async () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    const composer = within(dialog()).getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "old draft" } });

    openVendoConversation({ newConversation: true, prompt: "fresh start", send: false });

    // The remounted (fresh) composer carries the prompt; the old draft is gone.
    await waitFor(() => {
      const fresh = within(dialog()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
      expect(fresh.value).toBe("fresh start");
    });
  });

  it("queues a send:true prompt fired mid-turn instead of bypassing the single-in-flight contract", async () => {
    let release = () => undefined as void;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    const composer = within(dialog()).getByRole("textbox", { name: "Message" });

    fireEvent.change(composer, { target: { value: "First" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await within(dialog()).findByRole("button", { name: "Stop" });
    const posts = () => wire.requests.filter(r => r.method === "POST" && r.path === "/threads");
    await waitFor(() => expect(posts()).toHaveLength(1));

    // A remix fired while the turn streams must park in the QUEUED slot (the
    // .fl-queued pill), not dispatch as a concurrent send.
    openVendoConversation({ prompt: "Remix mid-stream", send: true });
    expect(await within(dialog()).findByText("Remix mid-stream", { selector: ".fl-queued-text" })).toBeTruthy();
    expect(posts()).toHaveLength(1);

    await act(async () => release());
    await within(dialog()).findByText("Turn complete");
    // Turn done → the queued remix auto-sends as the second turn.
    await waitFor(() => expect(posts()).toHaveLength(2));
  });

  it("prefills the composer WITHOUT sending by default (safe for destructive prompts)", async () => {
    render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();

    let opened: boolean | undefined;
    act(() => {
      opened = openVendoConversation({ prompt: "Pay my electric bill" });
    });
    expect(opened).toBe(true);

    // First open: the thread mounts lazily in this very commit and the parked
    // prompt lands in its composer — prefilled, never dispatched.
    await waitFor(() => {
      const composer = within(dialog()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
      expect(composer.value).toBe("Pay my electric bill");
    });
    expect(wire.requests.some(request => request.method === "POST" && request.path === "/threads")).toBe(false);
  });

  it("opens without a prompt, leaving the composer untouched", async () => {
    render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    act(() => {
      openVendoConversation();
    });
    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    expect((within(dialog()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("unregisters on unmount so a dead surface is never opened", () => {
    const { unmount } = render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    unmount();
    expect(openVendoConversation({ prompt: "late" })).toBe(false);
  });

  it("targets the opened overlay's composer, not an embedded thread mounted later", async () => {
    const { container } = render(
      <VendoProvider client={client}>
        <VendoOverlay defaultOpen launcher="none" />
        <VendoThread />
      </VendoProvider>,
    );
    const overlayComposer = within(dialog()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const embeddedComposer = within(container).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(embeddedComposer).not.toBe(overlayComposer);

    openVendoConversation({ prompt: "remix the hero", send: false });

    await waitFor(() => expect(overlayComposer.value).toBe("remix the hero"));
    expect(embeddedComposer.value).toBe("");
  });
});
