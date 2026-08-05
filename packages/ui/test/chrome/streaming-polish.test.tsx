// @vitest-environment jsdom
// ENG-217 — streaming polish: liveness (FluidThinking) fills the window between
// send and the FIRST chunk, the lone caret marks a streamed turn that is still
// empty, and the trailing caret (.fl-md--streaming) rides actively-flowing
// text. Each affordance exists only during its own streaming moment.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

function sendFromComposer(text: string) {
  const composer = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: "Enter" });
}

describe("streaming polish: caret + liveness (ENG-217)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  it("shows the lone caret while a streamed turn is still empty, never after", async () => {
    let releaseText = () => undefined as void;
    wire.state.textStartGate = new Promise<void>(resolve => { releaseText = resolve; });
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    await waitFor(() => expect(view.container.querySelector(".fl-caret")).toBeTruthy());
    // the caret IS the liveness indicator now — no doubled affordances
    expect(view.container.querySelector(".fl-typing")).toBeNull();

    await act(async () => releaseText());
    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector(".fl-caret")).toBeNull());
  });

  it("narrates the pre-first-chunk wait with liveness only — never view-shaped furniture", async () => {
    let releaseTurn = () => undefined as void;
    wire.state.turnStartGate = new Promise<void>(resolve => { releaseTurn = resolve; });
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("What is this?");
    // The turn is live and has produced nothing: liveness shows.
    await waitFor(() => expect(view.container.querySelector(".fl-typing, .fl-thinking")).toBeTruthy());
    // …and NOTHING that reads as a view being built. A prose-only turn never
    // calls vendo_make, so a document-shaped skeleton card here is a
    // promise the turn may never keep (live demo, 2026-07-28).
    expect(view.container.querySelector(".fl-skeleton")).toBeNull();
    expect(view.container.querySelector(".fl-generating")).toBeNull();

    await act(async () => releaseTurn());
    expect(await screen.findByText("Turn complete")).toBeTruthy();
    // …and liveness stands down once the turn settles.
    await waitFor(() => expect(view.container.querySelector(".fl-typing, .fl-thinking")).toBeNull());
  });

  it("marks flowing text as streaming (trailing caret) only while the stream is live", async () => {
    let releaseMid = () => undefined as void;
    wire.state.textMidGate = new Promise<void>(resolve => { releaseMid = resolve; });
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    // text is flowing: the trailing-caret class rides the markdown block
    await waitFor(() => expect(view.container.querySelector(".fl-md--streaming")).toBeTruthy());
    // the lone caret is only for an EMPTY streamed turn
    expect(view.container.querySelector(".fl-caret")).toBeNull();

    await act(async () => releaseMid());
    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector(".fl-md--streaming")).toBeNull());
  });
});
