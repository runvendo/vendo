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
  vi.restoreAllMocks();
});

const OK: ToolOutcome = { status: "ok", output: { balance: 12 } };

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
});
