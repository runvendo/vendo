import { afterEach, describe, expect, it } from "vitest";

import { defaultFetch } from "./fetch.js";

const realFetch = globalThis.fetch;

/** Mimics Workers/browser strict Web APIs: invoking a detached `fetch`
    reference (`this` !== globalThis) throws "Illegal invocation". */
function installStrictFetch(): { calls: Array<{ input: unknown; init: unknown }> } {
  const calls: Array<{ input: unknown; init: unknown }> = [];
  function strictFetch(this: unknown, input: unknown, init?: unknown): Promise<Response> {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    calls.push({ input, init });
    return Promise.resolve(new Response("ok"));
  }
  globalThis.fetch = strictFetch as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("defaultFetch", () => {
  it("survives runtimes that reject a detached fetch reference", async () => {
    const { calls } = installStrictFetch();
    // The raw pattern this helper replaces is exactly the hazard:
    const detached = globalThis.fetch;
    await expect(async () => detached("https://vendo.invalid/")).rejects.toThrow("Illegal invocation");
    // The helper, stored and called the same detached way, must not throw.
    const stored = defaultFetch;
    const response = await stored("https://vendo.invalid/");
    expect(await response.text()).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("late-binds so a fetch installed after capture is used", async () => {
    const stored = defaultFetch;
    installStrictFetch();
    let sawUrl: unknown;
    const probe: typeof fetch = (input, init) => {
      sawUrl = input;
      void init;
      return Promise.resolve(new Response("late"));
    };
    globalThis.fetch = probe;
    const response = await stored("https://vendo.invalid/late");
    expect(sawUrl).toBe("https://vendo.invalid/late");
    expect(await response.text()).toBe("late");
  });
});
