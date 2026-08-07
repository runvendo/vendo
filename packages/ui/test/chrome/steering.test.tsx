// @vitest-environment jsdom
/**
 * Mid-build steering, from the composer's side (§10.2).
 *
 * The queued slot already existed — one parked message, flushed on the busy
 * edge. This is what changed: while a turn is in flight the parked message is
 * OFFERED to that turn, and if the turn takes it, the user's words become a
 * normal user turn in the transcript instead of a second send at the end.
 *
 * Driven through the real wire server, so the client's own request and the
 * server's own answer are what decide the behaviour — the client has no
 * capability protocol and nothing to ask.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("steering the build in flight", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  /** Set by startHeldTurn; released in afterEach so ONE failing assertion cannot
   *  leave a gated turn holding the server open and turn into a hook timeout. */
  let releaseHeld: (() => void) | undefined;

  afterEach(async () => {
    releaseHeld?.();
    releaseHeld = undefined;
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  const dialog = () => screen.getByRole("dialog", { name: "Vendo assistant" });
  const turns = () => wire.requests.filter(r => r.method === "POST" && r.path === "/threads");
  const steers = () => wire.requests.filter(r => r.method === "POST" && r.path.endsWith("/steer"));

  /** Open a turn and hold it open; returns the release. `[steerable]` is the
   *  fixture's per-turn opt-in for a turn that can take a mid-build message. */
  async function startHeldTurn(steerable: boolean): Promise<() => void> {
    let release = () => undefined as void;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    const composer = within(dialog()).getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, {
      target: { value: `${steerable ? "[steerable] " : ""}build me a workbench` },
    });
    fireEvent.keyDown(composer, { key: "Enter" });
    await within(dialog()).findByRole("button", { name: "Stop" });
    await waitFor(() => expect(turns()).toHaveLength(1));
    // The turn's id rides the POST's response HEADERS, and a steer offered
    // before the client has read them is answered `false` with no request at
    // all — the message just keeps its turn-end flush. `turns()` only proves
    // the SERVER saw the POST, so wait for the first streamed chunk to render:
    // that is the client having consumed the response, id included.
    await within(dialog()).findByLabelText("Approval for Send the report");
    releaseHeld = release;
    return release;
  }

  const park = (text: string) => {
    const composer = within(dialog()).getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.keyDown(composer, { key: "Enter" });
  };

  it("delivers the parked message into the running turn and shows it as the user's own turn", async () => {
    const release = await startHeldTurn(true);

    park("group by client instead");
    // Parked first, exactly as before — the queue is unchanged.
    expect(await within(dialog()).findByText("group by client instead", { selector: ".fl-queued-text" })).toBeTruthy();

    // …then offered to the turn that is running.
    await waitFor(() => expect(steers()).toHaveLength(1));
    expect(steers()[0]!.body).toMatchObject({ text: "group by client instead" });
    expect((steers()[0]!.body as { messageId: string }).messageId).toBeTruthy();

    // It landed, so the words are in the transcript as a user turn…
    await within(dialog()).findByText("group by client instead", { selector: ".fl-usertext" });
    // …and the chip now reports DELIVERY, not a wait.
    expect(within(dialog()).getByText("Sent", { selector: ".fl-queued-tag" })).toBeTruthy();

    await act(async () => release());
    await within(dialog()).findByText("Turn complete");
    // THE POINT: no second turn. A landed steer is not a queued send.
    expect(turns()).toHaveLength(1);
  });

  it("keeps today's turn-end flush when the turn cannot take the message", async () => {
    const release = await startHeldTurn(false);

    park("group by client instead");
    await waitFor(() => expect(steers()).toHaveLength(1));
    // The chip still says it is waiting, because it is.
    expect(within(dialog()).getByText("Queued", { selector: ".fl-queued-tag" })).toBeTruthy();

    await act(async () => release());
    // Unchanged behaviour: it sends as the next turn, once, losing nothing.
    await waitFor(() => expect(turns()).toHaveLength(2));
    expect((turns()[1]!.body as { message: { parts: Array<{ text?: string }> } }).message.parts[0]?.text)
      .toBe("group by client instead");
  });

  it("a landed steer survives a reload — the server persisted it, not the screen", async () => {
    const release = await startHeldTurn(true);
    park("group by client instead");
    await waitFor(() => expect(steers()).toHaveLength(1));
    await within(dialog()).findByText("group by client instead", { selector: ".fl-usertext" });
    await act(async () => release());
    await within(dialog()).findByText("Turn complete");

    // Read back through the real read path, as a fresh mount would.
    const threadId = (steers()[0]!.path.match(/\/threads\/([^/]+)\/steer$/))![1]!;
    const thread = await client.threads.get(threadId);
    expect(thread!.messages.some(message =>
      message.role === "user"
      && message.parts.some(part => part.type === "text" && part.text === "group by client instead"))).toBe(true);
  });

  it("a message carrying attachments is never steered — it needs a turn of its own", async () => {
    const release = await startHeldTurn(true);

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const input = dialog().querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await within(dialog()).findByText("notes.txt");
    park("and use this");

    // Offered nothing: a steer carries WORDS, and an attachment cannot ride one.
    await waitFor(() => expect(within(dialog()).getByText("Queued", { selector: ".fl-queued-tag" })).toBeTruthy());
    expect(steers()).toHaveLength(0);

    await act(async () => release());
    await waitFor(() => expect(turns()).toHaveLength(2));
  });
});
