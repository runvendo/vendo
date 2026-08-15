// @vitest-environment jsdom
// The pill's smooth scroll owns the list for JUMP_MS so its own travelling
// frames are not misread as the reader scrolling away. A reader who changes
// their mind inside that window has to be able to take it back: their wheel or
// touch drag ends the ownership on the spot. Without that the scroll handler
// keeps ignoring them, and the next growth — a size observer tick while text is
// still streaming — re-sticks and drags them back down.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStickToBottom } from "../../src/chrome/thread/scrolling.js";

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

const messages: UIMessage[] = [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }] }];

/** The list bound exactly as message-list.tsx binds it. */
function List() {
  const scroll = useStickToBottom(messages, "thr_test");
  return (
    <div
      className="fl-msglist"
      ref={scroll.listRef}
      onScroll={scroll.onScroll}
      onWheel={scroll.endJump}
      onTouchMove={scroll.endJump}
    >
      <button type="button" onClick={scroll.jumpToLatest}>Jump to latest</button>
    </div>
  );
}

describe("a reader who changes their mind during the jump", () => {
  const original = globalThis.ResizeObserver;

  beforeEach(() => {
    observers.length = 0;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = original;
    cleanup();
  });

  it("keeps their position when growth lands inside the jump window", async () => {
    const view = render(<List />);
    const list = view.container.querySelector(".fl-msglist") as HTMLElement;

    // A viewport with a transcript taller than it, settled at the bottom.
    let height = 900;
    Object.defineProperty(list, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 300, configurable: true });
    await act(async () => { for (const deliver of observers) deliver(); });
    expect(list.scrollTop, "a settled reader sits at the bottom").toBe(900);

    // They press the pill — then immediately change their mind and wheel back
    // up, well inside the 600ms the jump would otherwise own the list for.
    fireEvent.click(view.getByRole("button", { name: "Jump to latest" }));
    fireEvent.wheel(list);
    list.scrollTop = 100;
    fireEvent.scroll(list);

    // Streaming keeps growing the content under them. It must not re-stick.
    height = 1100;
    await act(async () => { for (const deliver of observers) deliver(); });

    expect(list.scrollTop, "the reader's own scroll must outrank the jump").toBe(100);
  });
});
