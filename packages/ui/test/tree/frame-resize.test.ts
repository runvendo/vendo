// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyFrameResize, DEFAULT_FRAME_MAX_HEIGHT } from "../../src/tree/frame-resize.js";

/** A real iframe in the document, so `contentWindow` is a real other window. */
function mount(style: Partial<CSSStyleDeclaration> = {}): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  Object.assign(frame.style, style);
  document.body.appendChild(frame);
  return frame;
}

const resize = (source: Window | null, data: unknown) =>
  new MessageEvent("message", { source: source as MessageEventSource | null, data });

afterEach(() => { document.body.innerHTML = ""; });

describe("the frame resize protocol (one implementation, both frames)", () => {
  it("applies a well-formed report from the frame itself", () => {
    const frame = mount();
    expect(applyFrameResize(frame, resize(frame.contentWindow, { vendo: true, kind: "resize", height: 640 }))).toBe(true);
    expect(frame.style.height).toBe("640px");
  });

  it("ignores a resize from a DIFFERENT window (the identity gate)", () => {
    const frame = mount();
    const other = mount();
    // The spoof is well-formed in every respect except who sent it — an ad
    // frame, another embed, or the host page itself must not resize this frame.
    expect(applyFrameResize(frame, resize(other.contentWindow, { vendo: true, kind: "resize", height: 4_000 }))).toBe(false);
    expect(applyFrameResize(frame, resize(window, { vendo: true, kind: "resize", height: 4_000 }))).toBe(false);
    expect(applyFrameResize(frame, resize(null, { vendo: true, kind: "resize", height: 4_000 }))).toBe(false);
    expect(frame.style.height).toBe("");
  });

  it("ignores an unstamped message, a foreign kind, and a non-numeric height", () => {
    const frame = mount();
    const framed = frame.contentWindow;
    for (const data of [
      { kind: "resize", height: 500 },
      { vendo: false, kind: "resize", height: 500 },
      { vendo: true, kind: "render", height: 500 },
      { vendo: true, kind: "resize", height: "500" },
      { vendo: true, kind: "resize", height: Number.NaN },
      { vendo: true, kind: "resize", height: Number.POSITIVE_INFINITY },
      { vendo: true, kind: "resize" },
      "resize",
      null,
    ]) {
      expect(applyFrameResize(frame, resize(framed, data)), JSON.stringify(data)).toBe(false);
    }
    expect(frame.style.height).toBe("");
  });

  it("clamps at the default ceiling when the host configures nothing (today's jail behaviour)", () => {
    const frame = mount();
    applyFrameResize(frame, resize(frame.contentWindow, { vendo: true, kind: "resize", height: 10_000 }));
    expect(frame.style.height).toBe(`${DEFAULT_FRAME_MAX_HEIGHT}px`);
    expect(DEFAULT_FRAME_MAX_HEIGHT).toBe(8_192);
  });

  it("clamps at the HOST's max — the app never pushes the host's layout", () => {
    const frame = mount({ maxHeight: "420px" });
    applyFrameResize(frame, resize(frame.contentWindow, { vendo: true, kind: "resize", height: 1_600 }));
    expect(frame.style.height).toBe("420px");
  });

  it("clamps at the HOST's min — the slot the host reserved is kept", () => {
    const frame = mount({ minHeight: "320px" });
    applyFrameResize(frame, resize(frame.contentWindow, { vendo: true, kind: "resize", height: 96 }));
    expect(frame.style.height).toBe("320px");
  });

  it("lets the host's min win over its max, exactly as CSS does", () => {
    // used height = max(min-height, min(max-height, height)). A JS clamp that
    // disagreed with the cascade would make style.height a lie about the box.
    const frame = mount({ minHeight: "300px", maxHeight: "200px" });
    applyFrameResize(frame, resize(frame.contentWindow, { vendo: true, kind: "resize", height: 1_000 }));
    expect(frame.style.height).toBe("300px");
  });

  it("shrinks as well as grows, within the bounds", () => {
    const frame = mount({ minHeight: "16px", maxHeight: "8192px" });
    const framed = frame.contentWindow;
    applyFrameResize(frame, resize(framed, { vendo: true, kind: "resize", height: 1_400 }));
    expect(frame.style.height).toBe("1400px");
    applyFrameResize(frame, resize(framed, { vendo: true, kind: "resize", height: 280 }));
    expect(frame.style.height).toBe("280px");
  });
});
