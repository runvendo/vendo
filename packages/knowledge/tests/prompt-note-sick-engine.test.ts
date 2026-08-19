import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import type { KnowledgeAdapter } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { knowledgeIndexResolver } from "../src/prompt-note.js";

const readers = { readConfig: () => undefined, readManifest: () => "v1" };

/** The wire client aborts a status() at its own 30s timeout (`wire.ts`
    DEFAULT_TIMEOUT_MS), so an engine that is UP but hanging bills 30s to every
    turn before the prompt can be built. The clock is faked rather than slept:
    a real sleep here would be a second, invisible speed limit on the test. */
describe("knowledgeIndexResolver (an engine that fails SLOWLY is not re-probed every turn)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks a TIMING-OUT engine once per cool-off, not once per turn, and retries after it", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const base = memoryKnowledgeAdapter();
    const hanging: KnowledgeAdapter = {
      ...base,
      posture: base.posture,
      status: async () => {
        statusCalls += 1;
        vi.setSystemTime(Date.now() + 30_000);
        throw new Error("knowledge engine unreachable");
      },
    };
    const resolve = knowledgeIndexResolver(hanging, readers);

    expect(await resolve()).toBeUndefined();
    expect(statusCalls).toBe(1);

    // Later turns inside the cool-off pay nothing and still see no index.
    expect(await resolve()).toBeUndefined();
    expect(await resolve()).toBeUndefined();
    expect(statusCalls).toBe(1);

    vi.setSystemTime(Date.now() + 61_000);
    expect(await resolve()).toBeUndefined();
    expect(statusCalls).toBe(2);
  });
});
