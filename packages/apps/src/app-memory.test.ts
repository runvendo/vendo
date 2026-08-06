/**
 * The memory door's caps, through the REAL door and the REAL store.
 *
 * The caps live at the write site rather than in the schema so a stored row
 * survives a cap that changes — which means the only place they can be proved is
 * a write followed by a read. Nothing here is stubbed: `createApps` over a real
 * store, `runtime.remember` as the one writer, `runtime.get` as the reader.
 */
import type { AppId, RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { APP_MEMORY_DECISIONS_MAX_BYTES, APP_MEMORY_MAX_ASKS } from "./app-memory.js";
import { createApps, type AppsRuntime } from "./index.js";
import { authoringAssembler, basicLanguageModel, guardFixture, memoryStore } from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_memory" },
  venue: "chat",
  presence: "present",
  sessionId: "session_memory",
};

const WIRE = '<App name="Spending"><Text text="Spending"/><Disclaimer reason="Scripted fixture app."/></App>';

const runtimeWithApp = async (): Promise<{
  runtime: AppsRuntime;
  appId: AppId;
}> => {
  let runtime: AppsRuntime;
  runtime = createApps({
    store: memoryStore(),
    guard: guardFixture(),
    tools: {
      async descriptors() { return []; },
      async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
    },
    catalog: [],
    model: basicLanguageModel(),
    // The ONE engine: the app under test is landed by the real `authored` write
    // path, so `remember` writes onto a row a real create produced.
    screen: authoringAssembler(() => runtime, WIRE),
  });
  const app = await runtime.create({ prompt: "Show my spending" }, ctx);
  return { runtime, appId: app.id };
};

describe("the app's memory is capped at the write site", () => {
  it("keeps the last 20 asks — the 21st drops the first", async () => {
    const { runtime, appId } = await runtimeWithApp();

    for (let index = 1; index <= APP_MEMORY_MAX_ASKS; index += 1) {
      await runtime.remember({ appId, ask: `ask ${index}` }, ctx);
    }
    const full = await runtime.get(appId, ctx);
    expect(full?.memory?.asks).toHaveLength(APP_MEMORY_MAX_ASKS);
    expect(full?.memory?.asks[0]).toBe("ask 1");

    await runtime.remember({ appId, ask: "ask 21" }, ctx);

    const capped = await runtime.get(appId, ctx);
    expect(capped?.memory?.asks).toHaveLength(APP_MEMORY_MAX_ASKS);
    // The OLDEST goes, and the order of what is left is untouched.
    expect(capped?.memory?.asks[0]).toBe("ask 2");
    expect(capped?.memory?.asks.at(-1)).toBe("ask 21");
  });

  it("truncates an oversized decisions block, and marks that it truncated", async () => {
    const { runtime, appId } = await runtimeWithApp();
    const oversized = "d".repeat(APP_MEMORY_DECISIONS_MAX_BYTES * 3);

    await runtime.remember({ appId, decisions: oversized }, ctx);

    const stored = (await runtime.get(appId, ctx))?.memory?.decisions;
    expect(stored).toBeDefined();
    expect(new TextEncoder().encode(stored!).length).toBeLessThanOrEqual(APP_MEMORY_DECISIONS_MAX_BYTES);
    // A truncation the reader can SEE: a block that just stops is indistinguishable
    // from one the agent wrote that way.
    expect(stored!.endsWith("…")).toBe(true);
  });

  it("a later run's decisions REPLACE the earlier ones; a blank one leaves them alone", async () => {
    const { runtime, appId } = await runtimeWithApp();

    await runtime.remember({ appId, decisions: "no red — the user said so" }, ctx);
    await runtime.remember({ appId, ask: "add last month too" }, ctx);
    expect((await runtime.get(appId, ctx))?.memory?.decisions).toBe("no red — the user said so");

    await runtime.remember({ appId, decisions: "   " }, ctx);
    expect((await runtime.get(appId, ctx))?.memory?.decisions).toBe("no red — the user said so");

    await runtime.remember({ appId, decisions: "filtered to 2 accounts — the ask was trip-only" }, ctx);

    const stored = (await runtime.get(appId, ctx))?.memory;
    // REPLACED, not appended: the superseded line is gone, so it cannot be read
    // as a current constraint.
    expect(stored?.decisions).toBe("filtered to 2 accounts — the ask was trip-only");
    expect(stored?.decisions).not.toContain("no red");
    // …and the asks are untouched by a decisions-only write.
    expect(stored?.asks).toEqual(["add last month too"]);
  });

  it("a memory write needs editor access, like every other write to the row", async () => {
    const { runtime, appId } = await runtimeWithApp();
    const stranger: RunContext = { ...ctx, principal: { kind: "user", subject: "user_stranger" } };

    await expect(runtime.remember({ appId, ask: "let me in" }, stranger)).rejects.toThrow();
    expect((await runtime.get(appId, ctx))?.memory).toBeUndefined();
  });
});
