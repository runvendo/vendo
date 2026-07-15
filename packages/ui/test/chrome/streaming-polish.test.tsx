// @vitest-environment jsdom
// ENG-217 — streaming polish: the generating skeleton fills the window between
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

describe("streaming polish: caret + generating skeleton (ENG-217)", () => {
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

  it("shows the generating skeleton between send and the first chunk, then yields", async () => {
    let releaseTurn = () => undefined as void;
    wire.state.turnStartGate = new Promise<void>(resolve => { releaseTurn = resolve; });
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    await waitFor(() => expect(view.container.querySelector(".fl-generating")).toBeTruthy());
    expect(view.container.querySelector(".fl-skeleton")).toBeTruthy();
    // the skeleton replaces the working dots in this window
    expect(view.container.querySelector(".fl-typing")).toBeNull();

    await act(async () => releaseTurn());
    // first chunk landed: the skeleton yields (tool chips + working take over)
    await waitFor(() => expect(view.container.querySelector(".fl-generating")).toBeNull());
    expect(view.container.querySelector(".fl-skeleton")).toBeNull();
    expect(await screen.findByText("Turn complete")).toBeTruthy();
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
    expect(view.container.querySelector(".fl-generating")).toBeNull();

    await act(async () => releaseText());
    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector(".fl-caret")).toBeNull());
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
