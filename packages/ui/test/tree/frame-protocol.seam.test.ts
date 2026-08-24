// @vitest-environment jsdom
/**
 * The frame protocol's SEAM: the inner half that a sealed bundle runs
 * (`embedded-runtime.ts`) against the outer half the host runs
 * (`tree/frame-bridge.ts`), with no restatement of the envelope on either side.
 *
 * The two halves live in one package and could each be "tested" against a
 * hand-written copy of what the other sends — which is exactly how a protocol
 * ships dead. So every envelope below is produced by one real half and consumed
 * by the other.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolOutcome } from "@vendoai/core";
import { callHost, startFrameProtocol } from "../../src/embedded-runtime.js";
import { readFrameCall, replyToFrame, sendFrameTheme } from "../../src/tree/frame-bridge.js";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  document.querySelector("style[data-vendo-fonts]")?.remove();
  vi.restoreAllMocks();
});

const OK: ToolOutcome = { status: "ok", output: { balance: 12 } };
/** One `.vendo/fonts.css` face, as `vendo sync` inlines it. */
const FACE = "@font-face{font-family:'Maple';src:url(data:font/woff2;base64,d09GMg==) format('woff2')}";

/** jsdom's top window IS its own `parent`, so the inner half's listener accepts
 *  what this document dispatches — which is what a real host posts in. */
const toFrame = (data: unknown) =>
  window.dispatchEvent(new MessageEvent("message", { source: window, data }));

describe("the frame protocol, both real halves", () => {
  it("carries a call out and its outcome back", async () => {
    startFrameProtocol(document.createElement("div"));
    const out = vi.spyOn(parent, "postMessage");
    const answer = callHost("listAccounts", { limit: 2 });

    // What the INNER half actually posted, read by the OUTER half's gate.
    const envelope = out.mock.calls.at(-1)?.[0];
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const call = readFrameCall(frame, new MessageEvent("message", {
      source: frame.contentWindow as MessageEventSource,
      data: envelope,
    }));
    expect(call).toEqual({ id: expect.any(String), ref: "listAccounts", args: { limit: 2 } });

    // …and the reply the OUTER half writes, delivered to the inner half.
    const back = vi.spyOn(frame.contentWindow!, "postMessage");
    replyToFrame(frame, call!.id, OK);
    toFrame(back.mock.calls[0]![0]);
    await expect(answer).resolves.toEqual(OK);
  });

  it("applies the brand tokens the host sends, and only those", () => {
    startFrameProtocol(document.createElement("div"));
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const out = vi.spyOn(frame.contentWindow!, "postMessage");

    sendFrameTheme(frame, { "--vendo-color-accent": "#0a7", "--host-private": "leak" });
    toFrame(out.mock.calls[0]![0]);

    expect(document.documentElement.style.getPropertyValue("--vendo-color-accent")).toBe("#0a7");
    expect(document.documentElement.style.getPropertyValue("--host-private")).toBe("");
  });

  it("installs the host's data: font faces at render, beside the family token", () => {
    startFrameProtocol(document.createElement("div"));
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const out = vi.spyOn(frame.contentWindow!, "postMessage");

    sendFrameTheme(frame, { "--vendo-font-family": "Maple, sans-serif" }, FACE);
    toFrame(out.mock.calls[0]![0]);

    // The BYTES, not the name: a sealed bundle renders in an opaque origin the
    // host's own stylesheet never reaches, so "Maple" resolves to nothing
    // unless the face travels with the token.
    expect(document.querySelector("style[data-vendo-fonts]")?.textContent).toBe(FACE);
    expect(document.body.style.fontFamily).toBe("var(--vendo-font-family, system-ui, sans-serif)");
  });

  it("falls back to the family token when the host has no face to send", () => {
    startFrameProtocol(document.createElement("div"));
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const out = vi.spyOn(frame.contentWindow!, "postMessage");

    sendFrameTheme(frame, { "--vendo-font-family": "Maple, sans-serif" });
    toFrame(out.mock.calls[0]![0]);

    // No empty face and no broken load — the token is the whole answer.
    expect(document.querySelector("style[data-vendo-fonts]")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--vendo-font-family")).toBe("Maple, sans-serif");
  });
});
