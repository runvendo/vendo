// @vitest-environment jsdom
// Scrolling away MID-REPLY must raise the new-replies pill, and the growth that
// proves there is something new is growth no message change announces: streamed
// text is REVEALED at its own paced rate between deltas (markdown's
// useSmoothText). The size observer and the messages effect share one growth
// baseline, so whichever of them sees a growth first consumes it — when only
// the messages effect could flag, every mid-stream growth reached the observer
// first, the baseline advanced, and the reader who scrolled away mid-reply
// never got a pill (0 of 318 painted frames, against 129 of 333 on a control).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
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

const TURN: UIMessage = {
  id: "msg_reply",
  role: "assistant",
  parts: [{ type: "text", text: "Here is the beginning of a long answer." }],
};

/** A viewport the content is taller than, so scrolled-away is expressible. */
function size(list: HTMLElement, scrollHeight: number) {
  Object.defineProperty(list, "clientHeight", { value: 300, configurable: true });
  Object.defineProperty(list, "scrollHeight", { value: scrollHeight, configurable: true });
}

describe("the new-replies pill while a reply is still streaming", () => {
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

  it("raises the pill for growth that only the size observer witnesses", async () => {
    // An explicit thread id: a thread that starts without one gets a server
    // id minted mid-stream, and that flip deliberately clears the bar — a race
    // this test has no business running against.
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", { ...existing, messages: [...existing.messages, TURN] });
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Here is the beginning of a long answer.");

    const list = view.container.querySelector(".fl-msglist") as HTMLElement;
    expect(observers.length, "the list must be observed").toBeGreaterThan(0);

    // The reader is at the bottom of the reply so far — this settles the shared
    // growth baseline at the current height, the way a followed stream does.
    size(list, 600);
    list.scrollTop = 300;
    fireEvent.scroll(list);
    await act(async () => { for (const deliver of observers) deliver(); });

    // …and now scrolls away, mid-reply. No pill yet: nothing new has landed.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(view.container.querySelector(".fl-newbar")).toBeNull();

    // The reply keeps revealing text. No message identity changes — the size
    // observer is the only witness that the transcript grew at all.
    size(list, 900);
    await act(async () => { for (const deliver of observers) deliver(); });

    const pill = view.container.querySelector(".fl-newbar");
    expect(pill, "scrolling away mid-reply must raise the pill").toBeTruthy();
    expect(pill?.textContent).toContain("1 new reply");
    // Raising the pill is the whole response: streaming must never yank.
    expect(list.scrollTop, "the reader must keep their position").toBe(0);
  });
});
