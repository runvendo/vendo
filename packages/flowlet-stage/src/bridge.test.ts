import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeRpc } from "./bridge";
import type { MessageEndpoint } from "./protocol";

/**
 * Each endpoint is a mailbox: postMessage fires the "message" event on THAT endpoint,
 * and addEventListener registers a handler ON that same endpoint. This matches
 * window.postMessage semantics (the event fires on the target, not the sender),
 * making makeRpc(a, b) + makeRpc(b, a, onRequest) work without loopback.
 */
function makePair(): { a: MessageEndpoint; b: MessageEndpoint } {
  const aHandlers = new Set<(e: { data: unknown }) => void>();
  const bHandlers = new Set<(e: { data: unknown }) => void>();
  const a: MessageEndpoint = {
    postMessage: (m) => queueMicrotask(() => aHandlers.forEach((h) => h({ data: m }))),
    addEventListener: (_t, h) => aHandlers.add(h),
    removeEventListener: (_t, h) => aHandlers.delete(h),
  };
  const b: MessageEndpoint = {
    postMessage: (m) => queueMicrotask(() => bHandlers.forEach((h) => h({ data: m }))),
    addEventListener: (_t, h) => bHandlers.add(h),
    removeEventListener: (_t, h) => bHandlers.delete(h),
  };
  return { a, b };
}

describe("makeRpc", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) resolves with the peer's onRequest return value", async () => {
    const { a, b } = makePair();
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ping") return { pong: params };
      throw new Error("unknown method");
    });
    const host = makeRpc(a, b);

    const result = await host.call("ping", { x: 1 });
    expect(result).toEqual({ pong: { x: 1 } });

    host.dispose();
    peer.dispose();
  });

  it("(b) rejects with a timeout error if no response before timeoutMs", async () => {
    vi.useFakeTimers();
    const { a, b } = makePair();
    // peer side: no onRequest — never replies
    const peer = makeRpc(b, a);
    const host = makeRpc(a, b, undefined, { timeoutMs: 100 });

    const callPromise = host.call("noop");
    vi.advanceTimersByTime(101);
    // drain microtasks
    await Promise.resolve();

    await expect(callPromise).rejects.toMatchObject({ code: "timeout" });
    host.dispose();
    peer.dispose();
  });

  it("(c) rejects with abort error when AbortSignal fires after call starts", async () => {
    const { a, b } = makePair();
    // peer side: no onRequest — never replies
    const peer = makeRpc(b, a);
    const host = makeRpc(a, b, undefined, { timeoutMs: 30_000 });

    const controller = new AbortController();
    const callPromise = host.call("noop", undefined, { signal: controller.signal });
    controller.abort();
    await expect(callPromise).rejects.toMatchObject({ code: "abort" });

    host.dispose();
    peer.dispose();
  });

  it("(c) rejects immediately with abort error when signal is already aborted", async () => {
    const { a, b } = makePair();
    const peer = makeRpc(b, a);
    const host = makeRpc(a, b);

    const controller = new AbortController();
    controller.abort();
    await expect(host.call("noop", undefined, { signal: controller.signal })).rejects.toMatchObject({ code: "abort" });

    host.dispose();
    peer.dispose();
  });

  it("(d) ignores non-flowlet messages without throwing", async () => {
    const { a, b } = makePair();
    const peer = makeRpc(b, a, async () => "ok");
    const host = makeRpc(a, b);

    // Inject a non-flowlet message into host's listen endpoint (a).
    // With our endpoint semantics, a.postMessage delivers to a's own handlers (host's handler).
    a.postMessage({ notFlowlet: true, id: "rpc-0" });
    // Also inject a flowlet message with an unknown id — should be ignored silently.
    a.postMessage({ flowlet: true, id: "unknown-id-xyz", result: "stray" });

    // A real call should still work
    const result = await host.call("whatever");
    expect(result).toBe("ok");

    host.dispose();
    peer.dispose();
  });

  it("(e) rejects with bridge error when peer's onRequest throws", async () => {
    const { a, b } = makePair();
    const peer = makeRpc(b, a, async () => {
      throw new Error("handler exploded");
    });
    const host = makeRpc(a, b);

    await expect(host.call("boom")).rejects.toMatchObject({
      code: "bridge",
      message: "handler exploded",
    });

    host.dispose();
    peer.dispose();
  });

  // FIX 6: discrimination — an id-less {method} message is a notification, not a request.
  it("(f) does NOT invoke onRequest for a message with a method but no id", async () => {
    const { a, b } = makePair();
    const onRequest = vi.fn(async () => "ok");
    const peer = makeRpc(b, a, onRequest);

    // Inject an id-less method message onto b (where the peer listens).
    b.postMessage({ flowlet: true, method: "ui/action-result", params: { actionId: "x" } });
    await new Promise((r) => setTimeout(r, 0));

    expect(onRequest).not.toHaveBeenCalled();
    peer.dispose();
  });

  // FIX 6: a message carrying method + id + result that matches a pending id
  // resolves the pending call rather than being re-dispatched to onRequest.
  it("(g) a method+id+result message matching a pending id resolves the call, not re-dispatch", async () => {
    const { a, b } = makePair();
    const hostOnRequest = vi.fn(async () => "should-not-run");
    const host = makeRpc(a, b, hostOnRequest);

    // Peer listens on b for the request and replies with a response that ALSO
    // carries a `method` field — the response path must still win.
    b.addEventListener("message", (e) => {
      const m = e.data as { flowlet?: boolean; method?: string; id?: string };
      if (m?.method === "probe" && m.id) {
        a.postMessage({ flowlet: true, id: m.id, method: "sneaky", result: "RESOLVED" });
      }
    });

    const result = await host.call("probe");
    expect(result).toBe("RESOLVED");
    expect(hostOnRequest).not.toHaveBeenCalled();

    host.dispose();
  });
});
