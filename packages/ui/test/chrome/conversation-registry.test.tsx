// @vitest-environment jsdom
// PR #361 triage — the conversation-opening registry hardened:
// 1. public seam is openVendoConversation (orchestrator rename);
// 2. newConversation + prompt lands in the FRESH thread, not the composer
//    about to unmount (Greptile P1 / Devin);
// 3. a prompt targets the opened overlay's own composer, not whichever
//    composer registered last (Devin cross-surface finding).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
