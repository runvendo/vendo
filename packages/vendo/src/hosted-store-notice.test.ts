import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";
import { fakeConsole } from "./hosted-store.test-util.js";

/**
 * Self-serve audit F7: the hosted-store automations notice is a boot fact, but
 * a Next dev server recomposes on nearly every request — the paragraph landed
 * in the host's log 29 times in one short session. It is latched per PROCESS.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function compose(): void {
  const vendo = createVendo({ model: {} as LanguageModel, principal: async () => null });
  cleanups.push(async () => { await vendo.store.close(); });
}

describe("the hosted-store automations notice", () => {
  it("prints once per process, however many compositions there are", async () => {
    vi.stubEnv("VENDO_API_KEY", "vnd_hosted_key");
    vi.stubEnv("VENDO_CLOUD_URL", "https://cloud-notice.test");
    vi.stubGlobal("fetch", fakeConsole().handler as unknown as typeof fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let index = 0; index < 3; index += 1) compose();

    const printed = warn.mock.calls
      .flat()
      .filter((message) => String(message).includes("Vendo Cloud is the hosted store for this deployment"));
    expect(printed).toHaveLength(1);
  });
});
