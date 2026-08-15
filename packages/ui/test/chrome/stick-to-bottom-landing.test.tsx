// @vitest-environment jsdom
// A conversation that begins on its LANDING has no .fl-msglist for the stick's
// size observer to attach to when the hook mounts — the chrome renders the
// greeting instead. The observer has to attach when the list appears, because
// it is the only witness to growth that no message change announced: streamed
// text is REVEALED at its own paced rate between deltas (markdown's
// useSmoothText), and a generated view lays out late. Without it the view
// followed the wire's deltas only, and a live streamed turn spent ~27% of its
// painted frames with the newest line below the fold.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** Records every live observer so the test can deliver a resize itself —
    jsdom lays nothing out, so growth is something a test states, not causes. */
const observers: (() => void)[] = [];
class TestResizeObserver {
  constructor(private callback: () => void) {
    observers.push(() => this.callback());
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("stick-to-bottom on a thread that starts empty", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;
  const original = globalThis.ResizeObserver;

  beforeEach(async () => {
    observers.length = 0;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    globalThis.ResizeObserver = original;
    cleanup();
    await wire.close();
  });

  it("follows growth no message announced, once the list exists", async () => {
    const view = render(<VendoProvider client={client}><VendoThread /></VendoProvider>);
    // The landing: there is no list yet, so nothing to observe.
    expect(view.container.querySelector(".fl-msglist")).toBeNull();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Hello" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    const list = await waitFor(() => {
      const found = view.container.querySelector(".fl-msglist");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(await screen.findByText("Turn complete")).toBeTruthy();

    // The turn grows taller than the viewport with no message change to
    // announce it — exactly what a paced reveal does between two deltas.
    Object.defineProperty(list, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(list, "scrollHeight", { value: 900, configurable: true });
    list.scrollTop = 0;

    expect(observers.length, "the list must be observed once it exists").toBeGreaterThan(0);
    await act(async () => { for (const deliver of observers) deliver(); });

    expect(list.scrollTop, "the newest content must not be left below the fold").toBe(900);
  });
});
