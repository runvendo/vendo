import { describe, expect, it, vi } from "vitest";

/**
 * The workerd deploy-blocker check (unified-try-surface INVESTIGATE task,
 * 2026-07-26): verified live against real workerd via Miniflare that
 * `node:worker_threads` resolves and exports `Worker` there (nodejs_compat),
 * but the constructor itself throws synchronously — "The Worker method is
 * not implemented" — since Workers has no OS-thread model. Before this fix,
 * that throw escaped `renderOne` uncaught, rejecting `smokeRenderIslands`
 * (and therefore every `create()` call reaching the gate) instead of
 * degrading like every other unavailable-environment case the module already
 * documents. This mirrors the real failure with a mock (no Miniflare needed
 * for a fast unit run) and asserts the gate now skips silently.
 */
vi.mock("node:worker_threads", () => ({
  Worker: class {
    constructor() {
      throw new Error("The Worker method is not implemented");
    }
  },
}));

describe("smokeRenderIslands on a Worker-thread-less environment (workerd)", () => {
  it("skips the gate silently instead of throwing when new Worker() is unimplemented", async () => {
    const { smokeRenderIslands } = await import("../src/server/checking/smoke-render.js");
    const source = `
export default function ClientList() {
  return <Text text="hello" />;
}
`;
    await expect(smokeRenderIslands({
      components: { ClientList: source },
      componentTools: { ClientList: [] },
      tools: [],
    })).resolves.toEqual([]);
  }, 30_000);
});
