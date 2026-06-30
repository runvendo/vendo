import { describe, it, expect, vi } from "vitest";
import { buildSrcdoc, connectStage } from "./stage-host";
import { makeRpc } from "./bridge";
import type { MessageEndpoint } from "./protocol";

/**
 * Mailbox pair: same semantics as bridge.test.ts.
 * endpoint.postMessage(m) fires that endpoint's OWN handlers (target receives).
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

// ── buildSrcdoc ─────────────────────────────────────────────────────────────

describe("buildSrcdoc", () => {
  it("returns non-empty HTML with connect-src CSP, lang=en, and a title element", () => {
    const html = buildSrcdoc();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('lang="en"');
    expect(html).toContain("<title>");
  });
});

// ── connectStage ─────────────────────────────────────────────────────────────
//
// Setup convention:
//   a = host listen endpoint  (host reads from a; peer posts to a)
//   b = host post endpoint    (host writes to b; peer reads from b)
//
//   host side:  connectStage({ listen: a, post: b }, { onAction })
//   peer side:  makeRpc(b, a, peerOnRequest)   ← listens on b, calls back to a
//
// peer.call("tools/call", ...)  → posts to a → host handleRequest
// controller.initialize(...)   → host rpc.call("ui/initialize") → posts to b → peerOnRequest

describe("connectStage", () => {
  it("initialize sends ui/initialize with per-node capability tokens; tokens differ across nodes", async () => {
    const { a, b } = makePair();
    let initParams: any;
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") { initParams = params; return { ok: true }; }
      return {};
    });
    const controller = connectStage(
      { listen: a, post: b },
      { onAction: async () => ({ result: "ok" }) },
    );

    await controller.initialize({
      theme: {},
      state: {},
      bundleSource: "",
      tree: {
        id: "root",
        kind: "component",
        source: "host",
        name: "Card",
        props: {},
        children: [{ id: "child1", kind: "component", source: "host", name: "Button", props: {} }],
      },
    });

    expect(initParams.tree.capability).toBeDefined();
    expect(typeof initParams.tree.capability).toBe("string");
    expect(initParams.tree.children[0].capability).toBeDefined();
    // Tokens must differ between parent and child
    expect(initParams.tree.capability).not.toBe(initParams.tree.children[0].capability);

    controller.dispose();
    peer.dispose();
  });

  it("tools/call with CORRECT capability token reaches onAction as ActionRequest and returns ActionResult", async () => {
    const { a, b } = makePair();
    const onAction = vi.fn().mockResolvedValue({ result: "confirmed" });
    let initParams: any;
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") { initParams = params; return { ok: true }; }
      return {};
    });
    const controller = connectStage({ listen: a, post: b }, { onAction });

    await controller.initialize({
      theme: {},
      state: {},
      bundleSource: "",
      tree: { id: "root", kind: "component", source: "host", name: "Card", props: {} },
    });

    const rootToken = initParams.tree.capability as string;

    const result = await peer.call("tools/call", {
      name: "confirm",
      originNodeId: "root",
      capability: rootToken,
      payload: { amount: 10 },
    });

    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        originNodeId: "root",
        action: "confirm",
        payload: { amount: 10 },
        capability: rootToken,
      }),
    );
    expect(result).toEqual({ result: "confirmed" });

    controller.dispose();
    peer.dispose();
  });

  it("tools/call with WRONG capability token is rejected with bridge error; onAction is not called", async () => {
    const { a, b } = makePair();
    const onAction = vi.fn().mockResolvedValue({ result: "ok" });
    const peer = makeRpc(b, a, async (method) => {
      if (method === "ui/initialize") return { ok: true };
      return {};
    });
    const controller = connectStage({ listen: a, post: b }, { onAction });

    await controller.initialize({
      theme: {},
      state: {},
      bundleSource: "",
      tree: { id: "root", kind: "component", source: "host", name: "Card", props: {} },
    });

    await expect(
      peer.call("tools/call", {
        name: "confirm",
        originNodeId: "root",
        capability: "wrong-token",
        payload: {},
      }),
    ).rejects.toMatchObject({ code: "bridge" });

    expect(onAction).not.toHaveBeenCalled();

    controller.dispose();
    peer.dispose();
  });

  it("approval-pending: tools/call stays pending until resolveAction delivers ui/action-result", async () => {
    const { a, b } = makePair();
    const onAction = vi.fn().mockResolvedValue({ pending: true } as const);

    let initParams: any;
    let resolveActionResult!: (params: unknown) => void;
    const actionResultDelivered = new Promise<unknown>((res) => {
      resolveActionResult = res;
    });

    // Peer onRequest captures ui/initialize params AND handles the ui/action-result notification
    // that arrives as a raw flowlet message (bridge sees it as a request with id=undefined
    // and calls onRequest; the response is ignored by the host).
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") { initParams = params; return { ok: true }; }
      if (method === "ui/action-result") { resolveActionResult(params); return {}; }
      return {};
    });
    const controller = connectStage({ listen: a, post: b }, { onAction });

    await controller.initialize({
      theme: {},
      state: {},
      bundleSource: "",
      tree: { id: "root", kind: "component", source: "host", name: "Card", props: {} },
    });

    const rootToken = initParams.tree.capability as string;

    // The immediate RPC response is { status: "pending", actionId }
    const pendingResult = await peer.call("tools/call", {
      name: "confirm",
      originNodeId: "root",
      capability: rootToken,
      payload: {},
    }) as { status: string; actionId: string };

    expect(pendingResult).toMatchObject({ status: "pending", actionId: expect.any(String) });
    const { actionId } = pendingResult;

    // resolveAction posts ui/action-result to the runtime side (b)
    controller.resolveAction(actionId, { result: "approved" });

    const received = await actionResultDelivered;
    expect(received).toEqual({ actionId, result: { result: "approved" } });

    controller.dispose();
    peer.dispose();
  });
});
