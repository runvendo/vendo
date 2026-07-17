// @vitest-environment jsdom
// ENG-215 — composer: type-while-streaming with queued send, edit last message,
// regenerate, and the focus-dump fix. Autogrow height (needs real layout) is
// proven in the browser harness; here we cover the behavioral contract in jsdom.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

function composer() {
  return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
}

function type(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
}

function threadPosts(wire: Awaited<ReturnType<typeof createWireServer>>) {
  return wire.requests.filter(request => request.method === "POST" && request.path === "/threads");
}

describe("composer: type-while-streaming, queued send, edit, regenerate (ENG-215)", () => {
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

  it("keeps the composer typeable while a turn streams (typing never blocked)", async () => {
    let release = () => undefined as void;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    type("First message");
    fireEvent.keyDown(composer(), { key: "Enter" });

    await screen.findByRole("button", { name: "Stop" });
    // The textarea is NOT disabled during the turn, and accepts more input.
    expect(composer().disabled).toBe(false);
    type("typing while it streams");
    expect(composer().value).toBe("typing while it streams");

    await act(async () => release()); // let the stream finish so the wire can close
    await screen.findByText("Turn complete");
  });

  it("does not dump focus to the body when a turn starts (overlay focus-trap fix)", async () => {
    let release = () => undefined as void;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    composer().focus();
    type("Focus me");
    fireEvent.keyDown(composer(), { key: "Enter" });

    await screen.findByRole("button", { name: "Stop" });
    // Before ENG-215 the composer disabled mid-turn, which blurred it to <body>
    // and broke Escape/the overlay focus trap. Focus now stays on the composer.
    expect(document.activeElement).toBe(composer());

    await act(async () => release());
    await screen.findByText("Turn complete");
  });

  it("queues a send during a turn and auto-sends it when the turn completes", async () => {
    let release = () => undefined as void;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    type("First");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await screen.findByRole("button", { name: "Stop" });
    // The Stop button rides the optimistic busy flip (status → "submitted"),
    // which lands a tick before the send's POST completes its round-trip to the
    // wire server. Poll for the recorded request rather than reading it the
    // instant Stop appears — under CI load the socket hasn't delivered it yet.
    await waitFor(() => expect(threadPosts(wire)).toHaveLength(1));

    // Queue a second message mid-turn via the Send affordance.
    type("Queued follow-up");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // It visibly queues (a pill), the input clears, and nothing is sent yet.
    expect(await screen.findByText("Queued follow-up")).toBeTruthy();
    expect(composer().value).toBe("");
    expect(threadPosts(wire)).toHaveLength(1);

    await act(async () => release());
    await screen.findByText("Turn complete");

    // Turn done → the queued message auto-sends as a real second turn, pill gone.
    await waitFor(() => expect(threadPosts(wire)).toHaveLength(2));
    expect(threadPosts(wire)[1]?.body).toMatchObject({
      message: { role: "user", parts: [{ type: "text", text: "Queued follow-up" }] },
    });
  });

  it("cancels a queued message before the turn completes", async () => {
    let release = () => undefined as void;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    type("First");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await screen.findByRole("button", { name: "Stop" });

    type("Queued then cancelled");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Queued then cancelled");
    fireEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));
    expect(screen.queryByText("Queued then cancelled")).toBeNull();

    await act(async () => release());
    await screen.findByText("Turn complete");
    // Only the original turn was ever sent.
    expect(threadPosts(wire)).toHaveLength(1);
  });

  it("edits the last user message: loads it into the composer and drops it from the transcript", async () => {
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    type("Original question");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await screen.findByText("Turn complete");
    expect(screen.getByText("Original question")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    // Text is back in the composer and the turn is gone from the transcript.
    expect(composer().value).toBe("Original question");
    await waitFor(() => expect(screen.queryByText("Original question", { selector: ".fl-usertext" })).toBeNull());
  });

  it("regenerates the last assistant response", async () => {
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    type("Answer me");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await screen.findByText("Turn complete");
    expect(threadPosts(wire)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    // Regenerate re-issues the turn from the preserved user message.
    await waitFor(() => expect(threadPosts(wire).length).toBeGreaterThanOrEqual(2));
  });
});
