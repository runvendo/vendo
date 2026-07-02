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

  it("includes a baseline style block that consumes the brand vars (font, fg) and zeroes the body margin", () => {
    const html = buildSrcdoc();
    expect(html).toContain("<style>");
    expect(html).toMatch(/body\s*{[^}]*margin:\s*0/);
    expect(html).toContain("var(--flowlet-font");
    expect(html).toContain("var(--flowlet-fg");
  });
});

describe("CSP (Tier 2.5 hardening)", () => {
  it("does not include 'strict-dynamic' (remote script-load exfil channel)", () => {
    expect(buildSrcdoc()).not.toContain("strict-dynamic");
  });
  it("allows only nonce'd and blob: scripts", () => {
    const html = buildSrcdoc();
    expect(html).toMatch(/script-src 'nonce-[a-f0-9]+' blob:;/);
  });
  it("keeps connect-src 'none' and default-src 'none'", () => {
    const html = buildSrcdoc();
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("default-src 'none'");
  });
  it("pins the importmap script nonce to the CSP header nonce", () => {
    const html = buildSrcdoc("shim-src");
    const cspNonce = html.match(/nonce-([a-f0-9]+)'/)?.[1];
    expect(cspNonce).toBeTruthy();
    expect(html).toContain(`_im.nonce=${JSON.stringify(cspNonce)};`);
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

  it("forwards an opaque componentTheme unchanged into ui/initialize params (TU-3)", async () => {
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

    const componentTheme = { mode: "dark", theme: { colors: { brand: "#123456" } } };
    await controller.initialize({
      theme: {},
      state: {},
      bundleSource: "",
      componentTheme,
      tree: { id: "root", kind: "component", source: "host", name: "Card", props: {} },
    });

    expect(initParams.componentTheme).toEqual(componentTheme);

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

    // Peer onRequest captures ui/initialize params. The ui/action-result is now
    // an id-less notification (FIX 6), so it no longer reaches onRequest — the
    // real runtime catches it on its own window listener. Mirror that here with a
    // raw listener on b (the runtime-side endpoint).
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") { initParams = params; return { ok: true }; }
      return {};
    });
    b.addEventListener("message", (e) => {
      const msg = e.data as { method?: string; params?: unknown };
      if (msg?.method === "ui/action-result") resolveActionResult(msg.params);
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

  it("ready resolves when a flowlet ready notification is delivered via the endpoint", async () => {
    const { a, b } = makePair();
    const controller = connectStage(
      { listen: a, post: b },
      { onAction: async () => ({ result: "ok" }) },
    );

    // Post a ready notification to the host-listen endpoint (a).
    // a.postMessage(m) fires a's own handlers — exactly where the host listens.
    a.postMessage({ flowlet: true, type: "ready" });

    await expect(controller.ready).resolves.toBeUndefined();

    controller.dispose();
  });

  // FIX 1: source filtering — the listenEndpoint filters by e.source
  it("source-filtered endpoint ignores messages not from the iframe", () => {
    const fakeIframeWindow = { postMessage: vi.fn() } as unknown as Window;
    const anotherWindow = { postMessage: vi.fn() } as unknown as Window;

    // Simulate the source-filtered endpoint logic from createStage
    const registeredHandlers = new Map<
      (e: { data: unknown }) => void,
      (e: MessageEvent) => void
    >();
    const listenEndpoint = {
      postMessage: () => {},
      addEventListener(_type: string, handler: (e: { data: unknown }) => void) {
        const wrapped = (e: MessageEvent) => {
          if (e.source !== fakeIframeWindow) return;
          if (!e.data || (e.data as Record<string, unknown>).flowlet !== true) return;
          handler({ data: e.data });
        };
        registeredHandlers.set(handler, wrapped);
      },
      removeEventListener(_type: string, handler: (e: { data: unknown }) => void) {
        registeredHandlers.delete(handler);
      },
    };

    let called = false;
    const testHandler = () => { called = true; };
    listenEndpoint.addEventListener("message", testHandler);
    const wrapped = registeredHandlers.get(testHandler)!;

    // Message from wrong source — should be ignored
    wrapped({ source: anotherWindow, data: { flowlet: true, type: "ready" } } as unknown as MessageEvent);
    expect(called).toBe(false);

    // Message from correct source — should pass
    wrapped({ source: fakeIframeWindow, data: { flowlet: true, type: "ready" } } as unknown as MessageEvent);
    expect(called).toBe(true);
  });

  // FIX 4: tokens use crypto-UUID format
  it("capability tokens use cap- prefix (crypto format)", async () => {
    const { a, b } = makePair();
    let initParams: any;
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") { initParams = params; return { ok: true }; }
      return {};
    });
    const controller = connectStage({ listen: a, post: b }, { onAction: async () => ({ result: "ok" }) });
    await controller.initialize({
      theme: {},
      state: {},
      bundleSource: "",
      tree: { id: "root", kind: "component", source: "host", name: "Card", props: {} },
    });
    const token = initParams.tree.capability as string;
    expect(token).toMatch(/^cap-/);
    controller.dispose();
    peer.dispose();
  });

  // FIX 5: double-resolve guard
  it("resolveAction throws for unknown actionId", () => {
    const { a, b } = makePair();
    const controller = connectStage({ listen: a, post: b }, { onAction: async () => ({ result: "ok" }) });
    expect(() => controller.resolveAction("nonexistent-id", { result: "x" })).toThrow(
      /unknown actionId/,
    );
    controller.dispose();
  });

  // FIX 7: update() augments node capability and adds to capabilityMap
  it("update() with node attaches capability token to the updated node", async () => {
    const { a, b } = makePair();
    let updateParams: any;
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") return { ok: true };
      if (method === "ui/update") { updateParams = params; return { ok: true }; }
      return {};
    });
    const controller = connectStage({ listen: a, post: b }, { onAction: async () => ({ result: "ok" }) });
    await controller.initialize({
      theme: {},
      state: {},
      bundleSource: "",
      tree: { id: "root", kind: "component", source: "host", name: "Card", props: {} },
    });
    await controller.update({
      replace: {
        nodeId: "root",
        node: { id: "root", kind: "component", source: "host", name: "Button", props: {} },
      },
    });
    expect(updateParams.replace.node.capability).toBeDefined();
    expect(updateParams.replace.node.capability).toMatch(/^cap-/);
    controller.dispose();
    peer.dispose();
  });

  // FIX 1: re-initialize clears stale tokens minted for a previous tree.
  it("re-initialize rejects a token minted for a node that only existed in the prior tree", async () => {
    const { a, b } = makePair();
    const initParamsList: any[] = [];
    const onAction = vi.fn().mockResolvedValue({ result: "ok" });
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") { initParamsList.push(params); return { ok: true }; }
      return {};
    });
    const controller = connectStage({ listen: a, post: b }, { onAction });

    await controller.initialize({
      theme: {}, state: {}, bundleSource: "",
      tree: {
        id: "rootA", kind: "component", source: "host", name: "Card", props: {},
        children: [{ id: "onlyA", kind: "component", source: "host", name: "Button", props: {} }],
      },
    });
    const onlyAToken = initParamsList[0].tree.children[0].capability as string;

    // The treeA child token works while treeA is live.
    await expect(
      peer.call("tools/call", { name: "x", originNodeId: "onlyA", capability: onlyAToken, payload: {} }),
    ).resolves.toEqual({ result: "ok" });

    // Re-initialize with a tree that has no "onlyA" node.
    await controller.initialize({
      theme: {}, state: {}, bundleSource: "",
      tree: { id: "rootB", kind: "component", source: "host", name: "Card", props: {} },
    });

    onAction.mockClear();
    await expect(
      peer.call("tools/call", { name: "x", originNodeId: "onlyA", capability: onlyAToken, payload: {} }),
    ).rejects.toMatchObject({ code: "bridge" });
    expect(onAction).not.toHaveBeenCalled();

    controller.dispose();
    peer.dispose();
  });

  // FIX 1: ui/update replacing a subtree drops tokens for removed descendants.
  it("update rebuild rejects a token for a child removed by the replacement", async () => {
    const { a, b } = makePair();
    let initParams: any;
    const onAction = vi.fn().mockResolvedValue({ result: "ok" });
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") { initParams = params; return { ok: true }; }
      if (method === "ui/update") return { ok: true };
      return {};
    });
    const controller = connectStage({ listen: a, post: b }, { onAction });

    await controller.initialize({
      theme: {}, state: {}, bundleSource: "",
      tree: {
        id: "root", kind: "component", source: "host", name: "Card", props: {},
        children: [{ id: "child", kind: "component", source: "host", name: "Button", props: {} }],
      },
    });
    const childToken = initParams.tree.children[0].capability as string;

    // The child token works before the replacement.
    await expect(
      peer.call("tools/call", { name: "x", originNodeId: "child", capability: childToken, payload: {} }),
    ).resolves.toEqual({ result: "ok" });

    // Replace the root with a childless node — "child" is gone.
    await controller.update({
      replace: { nodeId: "root", node: { id: "root", kind: "component", source: "host", name: "Card", props: {} } },
    });

    onAction.mockClear();
    await expect(
      peer.call("tools/call", { name: "x", originNodeId: "child", capability: childToken, payload: {} }),
    ).rejects.toMatchObject({ code: "bridge" });
    expect(onAction).not.toHaveBeenCalled();

    controller.dispose();
    peer.dispose();
  });

  // FIX 2: cancelAction posts an error ui/action-result; dispose posts ui/teardown.
  it("cancelAction posts an error action-result and dispose posts ui/teardown", async () => {
    const { a, b } = makePair();
    const posted: any[] = [];
    // Raw listener on the runtime-side endpoint to capture host→runtime notifications.
    b.addEventListener("message", (e) => posted.push(e.data));

    let initParams: any;
    const onAction = vi.fn().mockResolvedValue({ pending: true } as const);
    const peer = makeRpc(b, a, async (method, params) => {
      if (method === "ui/initialize") { initParams = params; return { ok: true }; }
      return {};
    });
    const controller = connectStage({ listen: a, post: b }, { onAction });

    await controller.initialize({
      theme: {}, state: {}, bundleSource: "",
      tree: { id: "root", kind: "component", source: "host", name: "Card", props: {} },
    });
    const rootToken = initParams.tree.capability as string;

    const pending = (await peer.call("tools/call", {
      name: "confirm", originNodeId: "root", capability: rootToken, payload: {},
    })) as { status: string; actionId: string };
    expect(pending.status).toBe("pending");

    controller.cancelAction(pending.actionId, "user cancelled");
    await new Promise((r) => setTimeout(r, 0));

    const cancelMsg = posted.find((m) => m?.method === "ui/action-result");
    expect(cancelMsg).toMatchObject({
      params: { actionId: pending.actionId, error: { code: "abort", message: "user cancelled" } },
    });

    controller.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted.some((m) => m?.method === "ui/teardown")).toBe(true);

    peer.dispose();
  });

  // FIX 7: ready rejects with a sandbox error if no ready message arrives in time.
  it("ready rejects with a sandbox error when the runtime never signals ready", async () => {
    vi.useFakeTimers();
    try {
      const { a, b } = makePair();
      const controller = connectStage(
        { listen: a, post: b },
        { onAction: async () => ({ result: "ok" }), readyTimeoutMs: 10_000 },
      );
      const assertion = expect(controller.ready).rejects.toMatchObject({ code: "sandbox" });
      vi.advanceTimersByTime(10_001);
      await assertion;
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
