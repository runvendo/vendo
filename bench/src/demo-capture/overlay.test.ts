// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoBeatCompletionPhase, installCaptureOverlayInPage, remixCompletionPhase } from "./overlay.js";

describe("remixCompletionPhase", () => {
  it("reports continuity honestly", () => {
    expect(remixCompletionPhase(0)).toBe("REMIX COMPLETE · IFRAME STAYED VISIBLE");
    expect(remixCompletionPhase(3)).toBe("REMIX COMPLETE · 3 BLANK SAMPLES");
  });
});

describe("demoBeatCompletionPhase", () => {
  it("reports consent approvals honestly", () => {
    expect(demoBeatCompletionPhase(0)).toBe("BEAT COMPLETE");
    expect(demoBeatCompletionPhase(1)).toBe("BEAT COMPLETE · 1 CONSENT APPROVED");
    expect(demoBeatCompletionPhase(2)).toBe("BEAT COMPLETE · 2 CONSENTS APPROVED");
  });
});

describe("installCaptureOverlayInPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <form aria-label="Message composer">
        <textarea aria-label="Message"></textarea>
        <button aria-label="Send" type="submit">Send</button>
      </form>
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    delete window.__vendoDemoCapture;
  });

  it("starts on prompt submit and keeps the timer proof visible", async () => {
    installCaptureOverlayInPage({ label: "MAPLE", beat: "STREAMING FIRST PAINT" });

    const overlay = document.querySelector<HTMLElement>("[data-demo-capture-overlay]");
    expect(overlay?.textContent).toContain("MAPLE");
    expect(overlay?.textContent).toContain("ARMED");

    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1_250);

    expect(overlay?.textContent).toContain("00:01.250");
    expect(getComputedStyle(overlay!).display).not.toBe("none");
  });

  it("marks first paint and usable while preserving the latency bars", async () => {
    installCaptureOverlayInPage({ label: "CADENCE", beat: "STREAMING FIRST PAINT" });
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(750);

    const node = document.createElement("div");
    node.dataset.vendoNodeId = "root";
    Object.defineProperty(node, "getBoundingClientRect", {
      value: () => ({ width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300, x: 0, y: 0, toJSON() {} }),
    });
    document.body.append(node);
    await vi.advanceTimersByTimeAsync(50);

    const log = document.createElement("div");
    log.className = "fl-msglist";
    log.setAttribute("aria-busy", "false");
    document.body.append(log);
    await vi.advanceTimersByTimeAsync(100);

    const overlay = document.querySelector<HTMLElement>("[data-demo-capture-overlay]");
    expect(overlay?.textContent).toMatch(/FIRST PAINT\s+00:00\./);
    expect(overlay?.textContent).toMatch(/USABLE\s+00:00\./);
    expect(overlay?.textContent).toContain("BAR <1s PAINT");
    expect(overlay?.textContent).toContain("<10s USABLE");
  });

  it("ignores generated nodes that already existed when the overlay was installed", async () => {
    const makeNode = (id: string) => {
      const node = document.createElement("div");
      node.dataset.vendoNodeId = id;
      Object.defineProperty(node, "getBoundingClientRect", {
        value: () => ({ width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300, x: 0, y: 0, toJSON() {} }),
      });
      return node;
    };
    // A previous demo beat's view is still on screen (the thread is not reset
    // between beats), and its node ids can recur in the next generated view.
    document.body.append(makeNode("root"));

    installCaptureOverlayInPage({ label: "ACME WIDGETS", beat: "BEAT 2/3 · TAKE ACTION" });
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(500);

    const overlay = document.querySelector<HTMLElement>("[data-demo-capture-overlay]");
    expect(overlay?.textContent).toMatch(/FIRST PAINT\s+—/);

    document.body.append(makeNode("root"));
    await vi.advanceTimersByTimeAsync(50);
    expect(overlay?.textContent).toMatch(/FIRST PAINT\s+00:00\./);
  });

  it("disposes the previous overlay's ticker and listeners on reinstall", async () => {
    installCaptureOverlayInPage({ label: "ACME", beat: "BEAT 1/3 · GENERATE UI" });
    const baseline = vi.getTimerCount();
    installCaptureOverlayInPage({ label: "ACME", beat: "BEAT 2/3 · TAKE ACTION" });
    installCaptureOverlayInPage({ label: "ACME", beat: "BEAT 3/3 · SAVE APP" });
    // Reinstalls must clear the previous interval, not stack three tickers.
    expect(vi.getTimerCount()).toBe(baseline);
    expect(document.querySelectorAll("[data-demo-capture-overlay]")).toHaveLength(1);
  });

  it("reports continuous iframe visibility during a remix", async () => {
    installCaptureOverlayInPage({ label: "MAPLE", beat: "REMIX / EDIT", continuity: true });
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const frame = document.createElement("iframe");
    // Keep this aligned with JailedComponent's production title contract.
    frame.title = "Generated component: Demo";
    frame.srcdoc = "<main>ready</main>";
    Object.defineProperty(frame, "getBoundingClientRect", {
      value: () => ({ width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300, x: 0, y: 0, toJSON() {} }),
    });
    document.body.append(frame);
    window.__vendoDemoCapture?.watchContinuity();
    await vi.advanceTimersByTimeAsync(350);

    expect(document.querySelector("[data-demo-capture-continuity]")?.textContent)
      .toContain("IFRAME VISIBLE · BLANK SAMPLES 0");
  });
});
